/**
 * migrate_audit_log.js
 * Run once: node migrate_audit_log.js
 * Creates the admin_audit_log table used by the System Health dashboard.
 */
const mysql = require('mysql');

const db = mysql.createConnection({
    host:     process.env.DB_HOST     || 'c237-leonard-mysql.mysql.database.azure.com',
    user:     process.env.DB_USER     || 'c237_023',
    password: process.env.DB_PASSWORD || 'c237023@2026!',
    database: process.env.DB_NAME     || 'c237_023_team1_petcenter',
    ssl: { rejectUnauthorized: false }
});

db.connect((err) => {
    if (err) { console.error('Connection error:', err); process.exit(1); }
    console.log('Connected. Creating admin_audit_log table...');

    const sql = `
        CREATE TABLE IF NOT EXISTS admin_audit_log (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            actor       VARCHAR(100)  NOT NULL COMMENT 'username of staff who performed the action',
            action_type VARCHAR(60)   NOT NULL COMMENT 'e.g. PASSWORD_RESET, ACCOUNT_DELETED, DELETION_APPROVED, DELETION_CANCELLED',
            target_user VARCHAR(100)  NOT NULL COMMENT 'username of the affected user',
            details     VARCHAR(255)  NULL     COMMENT 'extra context (e.g. temp access code hint)',
            created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `;

    db.query(sql, (err2) => {
        if (err2) { console.error('Error creating table:', err2); }
        else       { console.log('admin_audit_log table ready.'); }
        db.end();
        process.exit(err2 ? 1 : 0);
    });
});
