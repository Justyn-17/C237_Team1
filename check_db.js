const mysql = require('mysql');
const db = mysql.createConnection({
    host: process.env.DB_HOST || 'c237-leonard-mysql.mysql.database.azure.com',
    user: process.env.DB_USER || 'c237_023',
    password: process.env.DB_PASSWORD || 'c237023@2026!',
    database: process.env.DB_NAME || 'c237_023_team1_petcenter',
    ssl: { rejectUnauthorized: false }
});

db.connect((err) => {
    if (err) {
        console.error('Database connection failed:', err);
        return;
    }
    console.log('Connected.');
    
    const monthlySql = "SELECT MONTH(date) AS month, COUNT(*) AS count FROM appointments WHERE YEAR(date) = YEAR(CURDATE()) AND status <> 'cancelled' AND vet_id = ? GROUP BY MONTH(date)";
    const vetId = 2; // Assuming vetId is 2 based on some typical test data, or I'll just query without vet_id to see if there are any appointments. Let's just query all appointments.
    
    db.query("SELECT vet_id, COUNT(*) as count FROM appointments WHERE YEAR(date) = YEAR(CURDATE()) AND status <> 'cancelled' GROUP BY vet_id", (err, res) => {
        console.log("Appointments per vet:", res);
        
        db.query(`SELECT a.vet_id, p.species, COUNT(DISTINCT p.id) AS count
                  FROM pets p
                  JOIN appointments a ON a.pet_id = p.id
                  GROUP BY a.vet_id, p.species`, (err, res2) => {
             console.log("Species per vet:", res2);
             db.end();
        });
    });
});
