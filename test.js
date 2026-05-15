require('dotenv').config();
const handler = require('./api/chat.js');
const req = {
  method: 'POST',
  headers: { origin: 'http://localhost:4000' },
  body: { query: 'Hello' }
};
const res = {
  setHeader: () => {},
  status: (code) => ({
    end: () => console.log('Status', code),
    json: (data) => console.log('Status', code, JSON.stringify(data, null, 2))
  })
};
handler(req, res).catch(console.error);
