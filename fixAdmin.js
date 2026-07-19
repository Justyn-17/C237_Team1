const mysql = require('mysql');
const bcrypt = require('bcrypt');

const db = mysql.createConnection({
    host: process.env.DB_HOST || 'c237-leonard-mysql.mysql.database.azure.com',
    user: process.env.DB_USER || 'c237_023',
    password: process.env.DB_PASSWORD || 'c237023@2026!',
    database: process.env.DB_NAME || 'c237_023_team1_petcenter',
    ssl: { rejectUnauthorized: false }
});

db.connect(async (err) => {
    if (err) {
        console.error('Database connection failed:', err);
        process.exit(1);
    }
    console.log('Connected to Azure MySQL database.');

    try {
        console.log("1. Expanding password_hash column to VARCHAR(255)...");
        await new Promise((resolve, reject) => {
            db.query("ALTER TABLE users MODIFY password_hash VARCHAR(255)", (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
        console.log("-> Column expanded successfully.");

        console.log("2. Generating bcrypt hash for 'password'...");
        const hash = await bcrypt.hash('password', 10);
        console.log(`-> Generated hash: ${hash}`);

        console.log("3. Updating 'admin' user with new hash...");
        await new Promise((resolve, reject) => {
            db.query("UPDATE users SET password_hash = ? WHERE username = 'admin'", [hash], (err, result) => {
                if (err) return reject(err);
                console.log(`-> Update successful. Affected rows: ${result.affectedRows}`);
                resolve();
            });
        });

        console.log("✅ Admin user fixed successfully! You can now log in.");
    } catch (error) {
        console.error("❌ An error occurred during the fix process:", error);
    } finally {
        db.end(() => {
            console.log("Database connection closed.");
            process.exit(0);
        });
    }
});
