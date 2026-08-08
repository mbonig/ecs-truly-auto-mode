import request from 'supertest';
import { app } from '../src/server';

describe('health', () => {
  it('returns 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});
