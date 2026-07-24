const mysql = require('mysql');

const db = mysql.createConnection({
    host: process.env.DB_HOST || 'c237-leonard-mysql.mysql.database.azure.com',
    user: process.env.DB_USER || 'c237_023',
    password: process.env.DB_PASSWORD || 'c237023@2026!',
    database: process.env.DB_NAME || 'c237_023_team1_petcenter',
    ssl: { rejectUnauthorized: false },
    dateString: true
});

db.connect(err => {
    if (err) throw err;
    db.query("SELECT a.id, a.date, a.start_time, a.end_time, a.reason, a.status, a.clinical_status, p.name AS pet_name, o.name AS owner_name FROM appointments a LEFT JOIN pets p ON a.pet_id = p.id LEFT JOIN users o ON a.owner_id = o.id WHERE a.vet_id = 30 AND a.date = '2026-07-24'", (err, result) => {
        console.log(result);
        db.end();
    });
});
