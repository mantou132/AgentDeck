import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFixture } from './helpers/app-fixture.mjs';

const daily = (timeZone) => ({ type: 'daily', times: ['09:00'], weekdays: [], timeZone });

test('formatSchedule names the time zone only when it is not this device’s', async () => {
  const { app } = documentFixture();
  const here = app.deviceTimeZone();
  const there = here === 'Asia/Shanghai' ? 'America/New_York' : 'Asia/Shanghai';
  const zoneName = new Intl.DateTimeFormat(app.i18n?.currentLanguage, { timeZone: there, timeZoneName: 'shortGeneric' })
    .formatToParts()
    .find((part) => part.type === 'timeZoneName').value;

  const local = app.formatSchedule(daily(here));
  assert.match(local, / 09:00$/);
  assert.equal(app.formatSchedule(daily(there)), `${local} ${zoneName}`);
});

test('a card matches a saved task only in the same time zone', async () => {
  const { app } = documentFixture();
  const task = { name: 'Inbox', prompt: 'Sort', schedule: daily('Asia/Shanghai') };
  app.tasksStore({ tasks: [task] });
  assert.equal(app.isDraftSaved(task), true);
  assert.equal(app.isDraftSaved({ ...task, schedule: daily('America/New_York') }), false);
});
