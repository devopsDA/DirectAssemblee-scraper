// http://www2.assemblee-nationale.fr/deputes/fiche/OMC_PA1012#autres
var Promise = require("bluebird");
var htmlparser = require('htmlparser2');

var currentMandatesParser = function(callback) {
  var mandates = [];
  var parsedItem = {};

  var expectedType = "";

  var expectMandates = false;
  var retrieveMandate = false;
  var previousDeputeMandatesRetrieved = false;
  var reallyExpectPreviousDeputesMandates = false;

  const TAG_OTHERS = "autres";
  const TAG_PAST_DEPUTE_MANDATES = "mandats-an-historique";
  const TAG_PAST_OTHER_GOUV_MISSIONS = "mandats-nationaux-historique";
  const TAG_PAST_INTL_MISSIONS = "internationales-judiciaires-historique";

  return new htmlparser.Parser({
    onopentag: function(tagname, attribs) {
      if (tagname === 'div' && (attribs.id == TAG_OTHERS || attribs.id == TAG_PAST_DEPUTE_MANDATES || attribs.id == TAG_PAST_OTHER_GOUV_MISSIONS || attribs.id == TAG_PAST_INTL_MISSIONS)) {
        mandates = [];
        expectedType = attribs.id;
        expectMandates = true;
      } else if (expectedType === TAG_PAST_DEPUTE_MANDATES) {
        if (reallyExpectPreviousDeputesMandates) {
          if (attribs.class === "fonctions-liste-attributs") {
            retrieveMandate = true;
          } else if (tagname === "h4") {
            reallyExpectPreviousDeputesMandates = false;
            retrieveMandate = false;
          }
        }
      } else if (expectMandates && tagname === "ul") {
        retrieveMandate = true;
      }
    },
    ontext: function(text) {
      if (expectedType === TAG_PAST_DEPUTE_MANDATES) {
        if (text === "Mandat de député") {
          reallyExpectPreviousDeputesMandates = true;
        }
      }
      if (retrieveMandate) {
        var trimmed = text.trim()
        if (trimmed) {
          mandates.push(trimmed);
        }
      }
    },
    onclosetag: function(tagname) {
      if (tagname === "div" && expectMandates) {
        if (expectedType === TAG_OTHERS) {
          parsedItem.otherCurrentMandates = mandates;
        } else if (expectedType === TAG_PAST_DEPUTE_MANDATES) {
          parsedItem.pastDeputeMandates = mandates;
        } else if (expectedType === TAG_PAST_OTHER_GOUV_MISSIONS) {
          parsedItem.otherPastGouvMissions = mandates;
        } else if (expectedType === TAG_PAST_INTL_MISSIONS) {
          parsedItem.otherPastInternationalMissions = mandates;
        }
        expectMandates = false;
        retrieveMandate = false;
      } else if (tagname === "h4" || tagname === "h3") {
        retrieveMandate = false;
      } else if (tagname === "html") {
        print(parsedItem)
        callback(parsedItem);
      }
    }
  }, {decodeEntities: true});
}

module.exports = {
  parse: function(content) {
    return new Promise(function(resolve, reject) {
      var parser = currentMandatesParser(function(mandates) {
        resolve(mandates);
      });
      parser.write(content);
      parser.end();
    })
  }
}

var print = function(parsedItem) {
  console.log("------------- ");
  console.log(parsedItem);
  console.log("------------- ");
}
