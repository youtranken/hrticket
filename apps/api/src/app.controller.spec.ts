import { Test } from '@nestjs/testing';
import { AppController } from './app.controller';

describe('AppController', () => {
  let controller: AppController;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AppController],
    }).compile();
    controller = moduleRef.get(AppController);
  });

  it('root returns ok status (Story 1.1 AC1)', () => {
    expect(controller.root()).toEqual({ name: 'hris-ticket-api', status: 'ok' });
  });

  it('ping responds', () => {
    expect(controller.ping()).toEqual({ pong: true });
  });
});
