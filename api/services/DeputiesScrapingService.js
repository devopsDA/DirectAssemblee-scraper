'use strict';

let Promise = require('bluebird');
let Constants = require('./Constants.js')

let WorkTypeHelper = require('./helpers/WorkTypeHelper')
let DateHelper = require('./helpers/DateHelper')
let WorkService = require('./database/WorkService')
let DeputiesListParser = require('./parsers/DeputiesListParser');
let DeclarationScrapingService = require('./DeclarationScrapingService');
let DeputyWorkParser = require('./parsers/DeputyWorkParser');
let DeputyQuestionThemeParser = require('./parsers/DeputyQuestionThemeParser');
let ThemeHelper = require('./helpers/ThemeHelper')
let DeputyWorkExtraInfosParser = require('./parsers/DeputyWorkExtraInfosParser');
let ExtraInfosLawProposalParser = require('./parsers/ExtraInfosLawProposalParser')
let ExtraInfosCommissionParser = require('./parsers/ExtraInfosCommissionParser')
let DeputyInfosParser = require('./parsers/DeputyInfosParser');
let DeputyInfosAndMandatesParser = require('./parsers/DeputyInfosAndMandatesParser');

const PARAM_WORK_TYPE = '{work_type}';
const PARAM_DEPUTY_NAME = '{deputy_name}';
const WORK_OFFICIAL_TYPES = WorkTypeHelper.allTypes();
const WORK_PAGE_SIZE = 10;

const DEPUTIES_LIST_URL = Constants.BASE_URL + 'deputes/liste/departements/(vue)/tableau';
const DEPUTY_INFO_URL = Constants.BASE_URL + 'deputes/fiche/OMC_PA' + Constants.PARAM_DEPUTY_ID;
const DEPUTY_WORK_URL = Constants.BASE_URL + 'deputes/documents_parlementaires/(offset)/' + Constants.PARAM_OFFSET + '/(id_omc)/OMC_PA' + Constants.PARAM_DEPUTY_ID + '/(type)/' + PARAM_WORK_TYPE;
const DEPUTY_DECLARATIONS_URL = 'http://www.hatvp.fr/fiche-nominative/?declarant=' + PARAM_DEPUTY_NAME;
const HATVP_DEPUTIES_LIST = 'http://www.hatvp.fr/resultat-de-recherche-avancee/?document=&mandat=depute&region=0&dep=';
const HATVP_DEPUTY_URL_START = 'http://www.hatvp.fr/fiche-nominative/?declarant=';

module.exports = {
    retrieveDeputiesList: function() {
        return FetchUrlService.retrieveContent(DEPUTIES_LIST_URL, DeputiesListParser);
    },

    retrieveDeputies: function(allDeputiesUrls, deputies) {
        return Promise.map(deputies, function(deputy) {
            return retrieveDeputyDetails(allDeputiesUrls, deputy)
        })
    },

    checkMandate: function(deputy) {
        let deputyUrl = DEPUTY_INFO_URL.replace(Constants.PARAM_DEPUTY_ID, deputy.officialId);
        return FetchUrlService.retrieveContent(deputyUrl, DeputyInfosParser)
        .then(function(deputyInfos) {
            if (deputyInfos) {
                if (deputyInfos.endOfMandateDate) {
                    console.log('/!\\ expired mandate for : ' + deputy.lastname + ' - end of mandate : ' + deputyInfos.endOfMandateDate);
                }
                deputy.endOfMandateDate = deputyInfos.endOfMandateDate;
                deputy.endOfMandateReason = deputyInfos.endOfMandateReason;
            }
            return deputy;
        });
    }
}

let retrieveDeputyDetails = function(allDeputiesUrls, deputy) {
    return DeclarationScrapingService.retrieveDeclarationPdfUrl(allDeputiesUrls, deputy.firstname, deputy.lastname)
    .then(function(declarations) {
        console.log('-- retrieved declarations for : ' + deputy.lastname);
        deputy.declarations = declarations;
        return deputy;
    })
    .then(async function(deputy) {
        return retrieveDeputyWork(deputy)
        .then(function(works) {
            deputy.works = works;
            console.log('-- retrieved works for : ' + deputy.lastname);
            return retrieveDeputyInfosAndMandates(deputy)
        })
        .then(function(fullDeputy) {
            console.log('-- retrieved infos and mandates from deputy ' + deputy.lastname);
            return fullDeputy;
        });
    })
}

let retrieveDeputyWork = function(deputy) {
    let deputyWorks = [];
    for (let i = 0 ; i < WORK_OFFICIAL_TYPES.length ; i++) {
        deputyWorks.push(retrieveDeputyWorkOfType(deputy, WORK_OFFICIAL_TYPES[i]))
    }
    return Promise.filter(deputyWorks, function(workOfType) {
        return workOfType.length > 0;
    })
    .then(function(works) {
        let concatWorks = [];
        for (let i in works) {
            for (let j in works[i]) {
                concatWorks.push(works[i][j]);
            }
        }
        return concatWorks;
    });
}

let retrieveDeputyWorkOfType = async function(deputy, parsedWorkType) {
    let results = [];
    let page = 0;

    let shouldGetNext = true;
    while (shouldGetNext) {
        let url = getWorkPageUrl(deputy, parsedWorkType, page);
        let works = await retrieveDeputyWorkOfTypeWithPage(url, parsedWorkType, deputy.lastWorkDate);
        shouldGetNext = false;
        if (works && works.length > 0) {
            for (let i in works) {
                results.push(works[i]);
            }
            shouldGetNext = works.length == WORK_PAGE_SIZE;
        }
        page++;
    }
    return results;
}

let getWorkPageUrl = function(deputy, parsedWorkType, pageOffset) {
    return DEPUTY_WORK_URL.replace(Constants.PARAM_DEPUTY_ID, deputy.officialId).replace(Constants.PARAM_OFFSET, pageOffset * WORK_PAGE_SIZE).replace(PARAM_WORK_TYPE, parsedWorkType);
}

let retrieveDeputyWorkOfTypeWithPage = function(workUrl, parsedWorkType, lastWorkDate) {
    return FetchUrlService.retrieveContent(workUrl, DeputyWorkParser)
    .then(function(works) {
        if (works) {
            return Promise.filter(works, function(work) {
                return work != undefined && (!lastWorkDate || DateHelper.isLaterOrSame(work.date, lastWorkDate));
            })
            .map(function(work) {
                return retrieveExtraForWork(work, parsedWorkType);
            })
            .map(function(work) {
                return WorkTypeHelper.getWorkTypeId(parsedWorkType)
                .then(function(workTypeId) {
                    work.subtype = {
                        name: work.subtype,
                        parentType: workTypeId
                    }
                    return setSubthemeToWork(work, parsedWorkType);
                })
            })
        } else {
            console.log('/!\\ work : no works')
            return null;
        }
    });
}

let retrieveExtraForWork = function(parsedWork, parsedWorkType) {
    if (!WorkTypeHelper.isPublicSession(parsedWorkType)) {
        return FetchUrlService.retrieveContentWithIsoEncoding(parsedWork.url, !WorkTypeHelper.isQuestion(parsedWorkType), getParserForType(parsedWorkType))
        .then(function(result) {
            if (result) {
                return processResultForType(parsedWork, parsedWorkType, result);
            } else {
                console.log('/!\\ no extra for work : ' + parsedWork.url)
                return parsedWork;
            }
        });
    } else {
        return parsedWork;
    }
}

let getParserForType = function(parsedWorkType) {
    let parser;
    if (WorkTypeHelper.isQuestion(parsedWorkType)) {
        parser = DeputyQuestionThemeParser;
    } else if (WorkTypeHelper.isProposition(parsedWorkType)) {
        parser = ExtraInfosLawProposalParser;
    } else if (WorkTypeHelper.isCommission(parsedWorkType)) {
        parser = ExtraInfosCommissionParser;
    } else {
        parser = DeputyWorkExtraInfosParser;
    }
    return parser;
}

let processResultForType = function(parsedWork, parsedWorkType, result) {
    let resultingWork;
    if (WorkTypeHelper.isQuestion(parsedWorkType)) {
        resultingWork = processResultForQuestion(parsedWork, result);
    } else if (WorkTypeHelper.isProposition(parsedWorkType) || WorkTypeHelper.isCommission(parsedWorkType)) {
        resultingWork = processResultForExtraInfos(parsedWork, parsedWorkType, result);
    } else {
        resultingWork = processResultForOtherTypes(parsedWork, result);
    }
    resultingWork.isCreation = WorkTypeHelper.isCreation(parsedWorkType)
    return resultingWork;
}

let processResultForQuestion = function(parsedWork, result) {
    parsedWork.parsedTheme = result;
    return parsedWork;
}

let processResultForExtraInfos = function(parsedWork, parsedWorkType, result) {
    parsedWork.id = result.id;
    if (result.description) {
        parsedWork.description = result.description;
    }
    parsedWork.parsedTheme = result.theme;
    parsedWork.extraInfos = result.extraInfos;

    parsedWork.subtype = adjustSubtypeNameIfCommission(parsedWork.subtype, parsedWorkType)
    return parsedWork;
}

let processResultForOtherTypes = function(parsedWork, result) {
    parsedWork.id = result.id;
    parsedWork.description = result.description;
    parsedWork.parsedTheme = result.theme;
    return parsedWork;
}

let adjustSubtypeNameIfCommission = function(workSubtype, parsedWorkType) {
    let subtype = workSubtype
    if (parsedWorkType == WorkTypeHelper.WORK_OFFICIAL_PATH_COMMISSIONS) {
        let split = workSubtype.split('-')[1];
        if (split) {
            subtype = split.trim();
        }
    }
    return subtype
}

let setSubthemeToWork = function(work, parsedWorkType) {
    let themeToSearch;
    if (work.parsedTheme) {
        themeToSearch = work.parsedTheme
    } else if (parsedWorkType === WorkTypeHelper.WORK_OFFICIAL_PATH_COMMISSIONS || parsedWorkType === WorkTypeHelper.WORK_OFFICIAL_PATH_PUBLIC_SESSIONS) {
        themeToSearch = 'Politique générale';
    }

    if (themeToSearch) {
        return searchSubtheme(work, themeToSearch)
        .then(function(foundSubtheme) {
            work.subtheme = foundSubtheme;
            if (!foundSubtheme) {
                work.unclassifiedTemporaryTheme = themeToSearch;
            }
            return work;
        })
    } else {
        return new Promise(function(resolve) {
            resolve(work);
        })
    }
}

let searchSubtheme = function(work, themeName) {
    return ThemeHelper.findSubtheme(themeName, true, work.url)
    .then(function(foundSubtheme) {
        if (!foundSubtheme) {
            console.log('/!\\ new theme not recognized : ' + themeName);
        }
        return foundSubtheme;
    })
}

let retrieveDeputyInfosAndMandates = function(deputy) {
    let mandatesUrl = DEPUTY_INFO_URL.replace(Constants.PARAM_DEPUTY_ID, deputy.officialId);
    return FetchUrlService.retrieveContent(mandatesUrl, DeputyInfosAndMandatesParser)
    .then(function(result) {
        if (result) {
            deputy.instancesWithRoles = result.instances;

            deputy.currentMandateStartDate = result.mandates.currentMandateStartDate;
            deputy.mandates = result.mandates;

            deputy.phone = result.infos.phone;
            deputy.email = result.infos.email;
            deputy.job = result.infos.job;
            deputy.birthDate = result.infos.birthDate;
            deputy.parliamentGroup = result.infos.parliamentGroup;
            deputy.seatNumber = result.infos.seatNumber;
            return deputy;
        } else {
            console.log('/!\\ no mandates')
            return;
        }
    })
}
