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
    db.query("ALTER TABLE tasks ADD COLUMN appointment_id INT DEFAULT NULL", (err, result) => {
        if (err) {
            if (err.code === 'ER_DUP_FIELDNAME') {
                console.log("Column appointment_id already exists.");
            } else {
                console.error(err);
            }
        } else {
            console.log("Column appointment_id added successfully.");
        }
        db.end();
    });
});
