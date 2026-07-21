const express = require('express');
const app = express();
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.get('/', (req, res) => {
  res.render('staff', { totalPets: 10, appointmentsToday: 5, appointments: [] });
});
app.listen(3001, () => console.log('Test server on 3001'));
