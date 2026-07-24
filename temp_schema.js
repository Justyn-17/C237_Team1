const mysql = require('mysql');
const db = mysql.createConnection({host: 'c237-leonard-mysql.mysql.database.azure.com', user: 'c237_023', password: 'c237023@2026!', database: 'c237_023_team1_petcenter', ssl: { rejectUnauthorized: false }});
db.connect(e => {
    if(e) throw e;
    db.query('DESCRIBE appointments', (e,r) => {
        console.log('appointments:', r);
        db.query('SHOW TABLES LIKE "tasks"', (e2,r2) => {
            console.log('tasks tables:', r2);
            db.end();
        });
    });
});
