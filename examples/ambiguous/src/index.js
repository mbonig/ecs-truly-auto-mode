const http = require('http');

// Disagrees with the Dockerfile's EXPOSE 8080.
const PORT = 4000;
const METRICS_PORT = 9090;

const server = http.createServer((req, res) => {
  if (req.url === '/api/items') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: [] }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// No health endpoint anywhere.
server.listen(PORT, () => console.log(`api on ${PORT}`));

http.createServer((_req, res) => res.end('metrics')).listen(METRICS_PORT);
