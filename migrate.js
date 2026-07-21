const mysql = require('mysql');

const db = mysql.createConnection({
    host: 'c237-leonard-mysql.mysql.database.azure.com',
    user: 'c237_023',
    password: 'c237023@2026!',
    database: 'c237_023_team1_petcenter',
    ssl: { rejectUnauthorized: false }
});

db.connect((err) => {
    if (err) {
        console.error("Connection error:", err);
        process.exit(1);
    }
    console.log("Connected to database. Running migration...");
    
    // Add status column
    db.query("ALTER TABLE users ADD COLUMN status ENUM('active', 'deletion_requested', 'deleted') DEFAULT 'active'", (err, result) => {
        if (err) {
            if (err.code === 'ER_DUP_FIELDNAME') {
                console.log("Status column already exists.");
            } else {
                console.error("Migration error:", err);
                process.exit(1);
            }
        } else {
            console.log("Migration successful.");
        }
        process.exit(0);
    });
});
