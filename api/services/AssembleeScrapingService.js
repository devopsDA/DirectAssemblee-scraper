'use strict';

let cron = require('node-cron');
let Promise = require('bluebird');

let DeputyService = require('./database/DeputyService.js');
let BallotService = require('./database/BallotService.js');
let VoteService = require('./database/VoteService.js');
let MandateService = require('./database/MandateService.js');
let ExtraPositionService = require('./database/ExtraPositionService.js');
let DeclarationService = require('./database/DeclarationService.js');
let WorkService = require('./database/WorkService.js');
let BallotsScrapingService = require('./BallotsScrapingService');
let DeputiesScrapingService = require('./DeputiesScrapingService');
let DeputyHelper = require('./helpers/DeputyHelper')
let DeclarationScrapingService = require('./DeclarationScrapingService')

const DEBUG = false;
const SCRAP_TIMES = '0 10,18 * * *';
//const SCRAP_TIMES = '0 0,15,30,45 * * * *';
const RANGE_STEP = 20;

let self = module.exports = {
    scrapThenStartService: function() {
        self.startScraping()
        .then(function() {
            self.startService();
        })
    },

    startService: function() {
        cron.schedule(SCRAP_TIMES, function() {
            console.log('=> start looking for new votes');
            self.startScraping()
        });
    },

    startScraping: async function() {
        console.log('==> start classifying unclassified questions');
        await WorkService.classifyUnclassifiedQuestions();

        console.log('==> retrieves declarations urls');
        let allDeputiesUrls = await DeclarationScrapingService.retrieveAllDeputiesDeclarationsUrls();

        console.log('==> start scraping deputies');
        let allDeputies = await DeputiesScrapingService.retrieveDeputiesList();

        let deputies = subArrayIfDebug(allDeputies, 0, 50);
        return retrieveAndInsertDeputiesByRange(allDeputiesUrls, deputies, 0)
        .then(function() {
            console.log('==> start scraping ballots');
            allDeputiesUrls = undefined;
            return BallotsScrapingService.retrieveBallotsList()
            .then(function(allBallots) {
                let ballots = subArrayIfDebug(allBallots, 0, allBallots.length);
                return retrieveAndInsertBallotsByRange(ballots, 0);
            })
        })
        .then(function() {
            RequestService.sendBallotsUpdateNotif();

            console.log('=> look for non-updated deputies');
            return DeputyService.findNonUpdatedDeputies()
            .then(function(nonUpdatedDeputies) {
                let promises = [];
                for (let i in nonUpdatedDeputies) {
                    promises.push(DeputiesScrapingService.checkMandate(nonUpdatedDeputies[i]))
                }
                return Promise.all(promises)
                .then(function(doneDeputies) {
                    let promises = [];
                    if (doneDeputies) {
                        for (let i in doneDeputies) {
                            if (doneDeputies[i].endOfMandateDate) {
                                promises.push(DeputyService.saveEndOfMandate(doneDeputies[i]))
                            }
                        }
                    }
                    console.log('* updating ' + promises.length + ' done deputies');
                    return Promise.all(promises)
                })
            })
            .then(function() {
                console.log('==> done updating database !!')
                return;
            })
        })
    }
}

let subArrayIfDebug = function(array, start, size) {
    if (DEBUG) {
        let subArray = [];
        for (let i = start ; i < start + size ; i++) {
            subArray.push(array[i])
        }
        return subArray;
    } else {
        return array;
    }
}

let retrieveAndInsertDeputiesByRange = function(allDeputiesUrls, deputies, start) {
    let slices = [];
    for (let i = start ; i < deputies.length ; i = i + RANGE_STEP) {
        let end = i + RANGE_STEP;
        if (end > deputies.length) {
            end = deputies.length;
        }
        slices.push(deputies.slice(i, end))
    }
    return retrieveSlicesOfDeputies(allDeputiesUrls, slices);
}

let retrieveSlicesOfDeputies = async function(allDeputiesUrls, slices) {
    for (let i in slices) {
        let start = i * RANGE_STEP;
        let end = start + RANGE_STEP;
        console.log('- retrieving deputies range ' + start + '-' + end);
        await retrieveAndInsertDeputies(allDeputiesUrls, slices[i]);
    }
    return;
}

let retrieveAndInsertDeputies = function(allDeputiesUrls, deputiesRange) {
    return DeputiesScrapingService.retrieveDeputies(allDeputiesUrls, deputiesRange)
    .then(function(deputiesRetrieved) {
        console.log('-- retrieved deputies ' + deputiesRetrieved.length)
        let promises = [];
        for (let i in deputiesRetrieved) {
            if (deputiesRetrieved[i]) {
                promises.push(insertDeputy(deputiesRetrieved[i]));
            }
        }
        deputiesRetrieved = undefined;
        return Promise.all(promises);
    })
}

let insertDeputy = function(deputy) {
    return DeputyService.insertDeputy(deputy, true)
    .then(function() {
        return MandateService.insertMandates(deputy.mandates, deputy.officialId)
    })
    .then(function() {
        console.log('-- inserted mandates for deputy : ' + deputy.lastname)
        deputy.mandates = undefined;
        return ExtraPositionService.insertExtraPositions(deputy.extraPositions, deputy.officialId);
    })
    .then(function() {
        console.log('-- inserted extra positions for deputy : ' + deputy.lastname)
        deputy.extraPositions = undefined;
        return DeclarationService.insertDeclarations(deputy.declarations, deputy.officialId);
    })
    .then(function() {
        console.log('-- inserted declarations for deputy : ' + deputy.lastname)
        deputy.declarations = undefined;
        return insertWorks(deputy.works, deputy.officialId)
        .then(function() {
            if (deputy.works && deputy.works.length > 0) {
                console.log('-- inserted works for deputy : ' + deputy.lastname)
                RequestService.sendDeputyUpdateNotif(deputy.officialId);
            }
            deputy.works = undefined
            deputy = undefined;
            return;
        })
    })
}

let insertWorks = function(works, deputyId) {
    return WorkService.clearWorksForDeputy(deputyId)
    .then(function() {
        return WorkService.insertWorks(works, deputyId);
    })
}

let retrieveAndInsertBallotsByRange = async function(ballots, start) {
    let slices = [];
    for (let i = start ; i < ballots.length ; i = i + RANGE_STEP) {
        let end = i + RANGE_STEP;
        if (end > ballots.length) {
            end = ballots.length;
        }
        slices.push(ballots.slice(i, end))
    }
    let deputiesNames = await DeputyService.getDeputiesNames();
    return retrieveSlicesOfBallots(slices, deputiesNames);
}

let retrieveSlicesOfBallots = async function(slices, deputiesNames) {
    for (let i in slices) {
        let start = i * RANGE_STEP;
        let end = start + RANGE_STEP;
        console.log('- retrieving ballots range ' + start + '-' + end);
        await retrieveAndInsertBallots(slices[i], deputiesNames);
    }
    return;
}

let retrieveAndInsertBallots = function(ballotsRange, deputiesNames) {
    return BallotsScrapingService.retrieveBallots(ballotsRange)
    .then(function(ballotsRangeRetrieved) {
        console.log('-- retrieved ballots ' + ballotsRangeRetrieved.length)
        return insertBallots(ballotsRangeRetrieved, 0)
        .then(function() {
            ballotsRangeRetrieved = null;
            return insertVotesForBallots(ballotsRange, deputiesNames);
        })
    })
}

let insertBallots = function(ballots) {
    let promises = [];
    for (let i in ballots) {
        if (ballots[i]) {
            promises.push(BallotService.insertBallot(ballots[i], true));
        }
    }
    return Promise.all(promises)
}

let insertVotesForBallots = function(ballots, deputiesNames) {
    let promises = [];
    for (let i in ballots) {
        promises.push(insertVotesForBallot(ballots[i], deputiesNames))
    }
    ballots = undefined;
    return Promise.all(promises);
}

let insertVotesForBallot = async function(ballot, deputies) {
    let votesToInsert = [];
    for (let i in ballot.votes) {
        let vote = ballot.votes[i]
        let deputyId;
        if (vote.deputy.officialId) {
            deputyId = await DeputyService.findDeputyWithOfficialId(vote.deputy.officialId);
        } else {
            deputyId = DeputyHelper.getDeputyIdForVoteInBallot(deputies, vote);
        }
        if (deputyId) {
            votesToInsert.push({ deputyId: deputyId, ballotId: ballot.officialId, value: vote.value });
        }
    }

    return VoteService.insertVotes(ballot.officialId, votesToInsert)
    .then(function() {
       ballot.nonVoting = findNonVotings(ballot.votes);
       return BallotService.insertBallot(ballot, true);
   })
}

let findNonVotings = function(votes) {
    let count = 0;
    for (let i in votes) {
        if (votes[i].value == 'non-voting') {
            count++;
        }
    }
    return count;
}
