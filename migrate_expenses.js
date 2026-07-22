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
    console.log("Connected to database. Running expense tracking migration...");

    const sql = `
        CREATE TABLE IF NOT EXISTS expenses (
            id            INT AUTO_INCREMENT PRIMARY KEY,
            owner_id      INT NOT NULL,
            pet_id        INT NULL,
            category      VARCHAR(50) NOT NULL,
            description   VARCHAR(255) NULL,
            amount        DECIMAL(10,2) NOT NULL,
            expense_date  DATE NOT NULL,
            created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

            CONSTRAINT fk_expenses_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
            CONSTRAINT fk_expenses_pet   FOREIGN KEY (pet_id)   REFERENCES pets(id)  ON DELETE SET NULL,

            INDEX idx_expenses_owner (owner_id),
            INDEX idx_expenses_date (expense_date),
            INDEX idx_expenses_category (category)
        )
    `;

    db.query(sql, (err, result) => {
        if (err) {
            if (err.code === 'ER_TABLE_EXISTS_ERROR') {
                console.log("expenses table already exists.");
            } else {
                console.error("Migration error:", err);
                process.exit(1);
            }
        } else {
            console.log("Migration successful: expenses table created.");
        }
        process.exit(0);
    });
});
