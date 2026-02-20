import app from './app';

const PORT = 3000;
const HOST = '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`========================================`);
  console.log(`SERVER STARTED ON http://${HOST}:${PORT}`);
  console.log(`========================================`);
});
