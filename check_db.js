
const Database = require('better-sqlite3');
const db = new Database('sqlite.db');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log(JSON.stringify(tables));
db.close();
