import express from 'express';

const app = express();
const PORT = Number(process.env.PORT ?? 8080);

// Health check for the load balancer target group.
app.get('/health', (_req, res) => res.sendStatus(200));

app.get('/greeting/:name', (req, res) => {
  res.json({ greeting: `Hello, ${req.params.name}` });
});

app.listen(PORT, () => {
  console.log(`listening on ${PORT}`);
});

export { app };
