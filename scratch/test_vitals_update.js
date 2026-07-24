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
    const weight = '15.5';
    const temperature = '38.5';
    const observations = 'test observations';
    const req_params_id = '23';
    const req_session_userId = 30; // jtest1

    db.query(
        "UPDATE appointments SET vitals_weight = ?, vitals_temperature = ?, vitals_observations = ? WHERE id = ? AND vet_id = ?",
        [weight || null, temperature || null, observations || null, req_params_id, req_session_userId],
        (err, result) => {
            if (err) {
                console.error("Error saving vitals:", err);
            }
            console.log("VITALS POST:", { id: req_params_id, body: { weight, temperature, observations }, vet_id: req_session_userId, affectedRows: result.affectedRows });
            
            db.query("SELECT vitals_weight, vitals_temperature, vitals_observations FROM appointments WHERE id = ?", [req_params_id], (err2, rows) => {
                console.log("After update:", rows);
                db.end();
            });
        }
    );
});
