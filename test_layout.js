const express = require('express');
const app = express();
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.get('/', (req, res) => {
  res.render('staff', { totalPets: 10, appointmentsToday: 5, appointments: [], role: 'staff' });
});
app.listen(3002, () => console.log('Test server on 3002'));
