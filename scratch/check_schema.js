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
    db.query("ALTER TABLE appointments ADD COLUMN clinical_status VARCHAR(50) DEFAULT NULL", (err, result) => {
        if (err) {
            // Ignore error if column already exists (e.g. Duplicate column name)
            if (err.code === 'ER_DUP_FIELDNAME') {
                console.log("Column clinical_status already exists.");
            } else {
                console.error(err);
            }
        } else {
            console.log("Column clinical_status added successfully.");
        }
        db.end();
    });
});
