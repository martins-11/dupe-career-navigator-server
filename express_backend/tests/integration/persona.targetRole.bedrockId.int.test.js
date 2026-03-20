import request from 'supertest';

import app from '../../src/server.js';

describe('POST/GET /api/personas/target-role accepts bedrock role ids', () => {
  test('persists and loads a bedrock-* role_id (memory fallback)', async () => {
    const user_id = '11111111-1111-1111-1111-111111111111';
    const role_id = 'bedrock-senior-data-analyst';
    const time_horizon = 'Mid';

    const postRes = await request(app)
      .post('/api/personas/target-role')
      .send({ user_id, role_id, time_horizon })
      .set('Content-Type', 'application/json');

    expect([201]).toContain(postRes.status);
    expect(postRes.body).toHaveProperty('status', 'ok');
    expect(postRes.body).toHaveProperty('target');
    expect(postRes.body.target).toMatchObject({
      userId: user_id,
      roleId: role_id,
      timeHorizon: time_horizon,
    });

    const getRes = await request(app).get('/api/personas/target-role').query({ user_id });

    expect([200]).toContain(getRes.status);
    expect(getRes.body).toHaveProperty('status', 'ok');
    expect(getRes.body).toHaveProperty('target');
    expect(getRes.body.target).toMatchObject({
      userId: user_id,
      roleId: role_id,
      timeHorizon: time_horizon,
    });
  });
});
