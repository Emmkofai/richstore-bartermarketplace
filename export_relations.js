const path = require('path');
const { readDB, buildAdminRelations } = require('../admin-server.js');

const db = readDB();
const relations = buildAdminRelations(db);
process.stdout.write(JSON.stringify(relations));
