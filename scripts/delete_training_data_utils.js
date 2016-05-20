/**
 * Utils for data deletion scripts.
 */

'use strict';

var _ = require('underscore');
var fs = require('fs');
var mkdirp = require('mkdirp');
var prompt = require('prompt');
var util = require('util');

// Overload console.log to log to file.
var setupLogging = function(logdir, logfile) {
  if (!mkdirp.sync(logdir)) {
    console.log('Couldnt create logdir, aborting.');
    process.exit();
  }
  var log_file = fs.createWriteStream(logdir + '/' + logfile, {flags : 'w'});
  log_file.write(''); // create file by writing in it
  var log_stdout = process.stdout;
  console.log = function(d) {
    log_file.write(util.format(d) + '\n');
    log_stdout.write(util.format(d) + '\n');
  };
};

// Useful to keep track of the last seq number, and who knows what else?
var printoutDbStats = function(db, data) {
  return db.info().then(function (result) {
    console.log('DB stats - ' + JSON.stringify(result));
    return data;
  });
};

var getDocsFromRows = function(rows) {
  return _.map(rows, function(row) {
    return row.doc;
  });
};

var getIdsFromRows = function(rows) {
  return _.map(rows, function(row) {
    return row.id;
  });
};

// Note : instead of deleting docs, we set {_deleted: true}, so that the
// deletions are replicated to clients.
var deleteDocs = function(dryrun, db, docs) {
  if (dryrun) {
    console.log('Dryrun : not deleting.');
    return docs;
  }
  var docsWithDeleteField = _.map(docs, function(doc) {
    doc._deleted = true;
    return doc;
  });

  return db.bulkDocs(docsWithDeleteField)
    .then(function (result) {
      console.log('Deleted : ' + result.length + ':');
      console.log(result);
      return result;
    });
};

var getContactsForPlace = function(db, placeId, batchSize) {
  return db.query(
    'medic/contacts_by_place',
    {key: [placeId], include_docs: true, limit: batchSize}
  ).then(function (result) {
    console.log('Contacts for place : ' + result.rows.length);
    var docs = getDocsFromRows(result.rows);
    return docs;
  });
};

var getDataRecordsForBranch = function(db, branchId, batchSize) {
  return db.query(
    'medic/data_records_by_district',
    {startkey: [branchId], endkey: [branchId + '\ufff0'], include_docs: true, limit: batchSize}
  ).then(function (result) {
    console.log('Reports for branch : ' + result.rows.length);
    return getDocsFromRows(result.rows);
  });
};

var filterByDate = function(docsList, startTimestamp, endTimestamp) {
  var filteredList = _.filter(docsList, function(doc) {
    return doc.reported_date && doc.reported_date >= startTimestamp && doc.reported_date < endTimestamp;
  });
  console.log('Filtered by date : ' + filteredList.length);
  return filteredList;
};

var filterByType = function(docsList, type) {
  var filteredList = _.filter(docsList, function(doc) { return doc.type === type; });
  console.log('Filtered by type ' + type + ' : ' + filteredList.length);
  return filteredList;
};

// Find which facilities (if any) this person is a contact for.
var isContactFor = function(db, personId) {
  return db.query('medic/facilities_by_contact', {key: [personId], include_docs: true})
    .then(function(result) {
      var ids = getIdsFromRows(result.rows);
      if (result.rows.length > 0) {
        console.log('Person ' + personId + ' is contact for ' + result.rows.length + ' facilities : ', ids);
      }
      return getDocsFromRows(result.rows);
    })
    .catch(function(err) {
      console.log('Error in isContactFor ' + personId);
      console.log(err);
      throw err;
    });
};

var removeContact = function(db, dryrun, person, facilitiesList) {
  _.each(facilitiesList, function(facility) {
    delete facility.contact;
  });

  if (dryrun) {
    console.log('Dryrun : not removing contact links.');
    return person;
  }

  return db.bulkDocs(facilitiesList)
    .then(function (result) {
      console.log('Removed contact ' + person._id + ' from ' + facilitiesList.length + ' facilities');
      console.log(result);
      return person;
    });
};

// If the persons are contacts for facilities, edit the facilities to remove the contact.
// Do it them one after the other, rather than concurrently, to avoid too many requests on the DB.
var cleanContactPersons = function(db, dryrun, logdir, personsList) {
  var promise = Promise.resolve();
  _.each(personsList, function(person) {
    promise = promise.then(function() { return cleanContactPerson(db, dryrun, logdir, person); });
  });
  return promise.then(function() { return personsList; });
};

var cleanContactPerson = function(db, dryrun, logdir, person) {
  return isContactFor(db, person._id)
      .then(function(facilities) {
        if (!facilities || facilities.length === 0) {
          return;
        }
        return writeDocsToFile(logdir + '/cleaned_facilities_' + person._id + '.json', facilities)
          .then(_.partial(removeContact, db, dryrun, person));
      })
      .catch(function (err) {
        console.log('Error when removing contact ' + person._id);
        console.log(err);
        throw err;
      });
    };

var writeDocsToFile = function(filepath, docsList) {
  if (docsList.length === 0) {
    // don't write empty files.
    return docsList;
  }
  return new Promise(function(resolve,reject){
    fs.writeFile(filepath, JSON.stringify(docsList), function(err) {
      if(err) {
        return reject('Couldn\'t write to file' + filepath, err);
      }
      console.log('Wrote ' + docsList.length + ' docs to file ' + filepath);
      resolve(docsList);
    });
  });
};

var fetchBranchInfo = function(db, branchId) {
  return db.get(branchId)
    .then(function(result) {
      return { _id: result._id, name: result.name, type: result.type };
    })
    .catch(function(err) {
      console.log('Couldnt find branch ' + branchId);
      throw err;
    });
};

var userConfirm = function(message) {
  console.log(message); // log to logfile because prompt doesn't.

  prompt.message = ''; // remove annoying pre-prompt message.
  var property = {
    name: 'yesno',
    message: message,
    validator: /y[es]*|n[o]?/,
    warning: 'Must respond yes or no',
    default: 'yes'
  };
  prompt.start();

  return new Promise(function(resolve) {
    prompt.get(property, function (err, result) {
      if (err) {
        console.log(err);
        process.exit();
      }
      if (result.yesno !== 'yes') {
        console.log('User backed out. Exiting.');
        process.exit();
      }
      resolve();
    });
  });
};

module.exports = {
  cleanContactPersons: cleanContactPersons,
  deleteDocs: deleteDocs,
  fetchBranchInfo: fetchBranchInfo,
  filterByType: filterByType,
  filterByDate: filterByDate,
  getContactsForPlace: getContactsForPlace,
  getDataRecordsForBranch: getDataRecordsForBranch,
  printoutDbStats: printoutDbStats,
  setupLogging: setupLogging,
  userConfirm: userConfirm,
  writeDocsToFile: writeDocsToFile
};