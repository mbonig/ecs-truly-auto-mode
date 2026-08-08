const express = require('express');
const app = express();
app.get('/health', (_req, res) => res.sendStatus(200));
app.listen(3000);
