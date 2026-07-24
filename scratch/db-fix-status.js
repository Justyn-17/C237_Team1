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
    db.query("UPDATE appointments SET status = 'booked' WHERE status = 'labs_pending'", (err, result) => {
        if (err) console.error(err);
        else console.log(`Updated ${result.affectedRows} appointments.`);
        db.end();
    });
});
