import { describe, it, expect } from 'vitest';
import { classifyCancelVsUpdate } from '../src/server/agent/handlers/cancelUpdate.js';

describe('cancelUpdate.ts - classifyCancelVsUpdate', () => {
  it('classifies unambiguous cancel words/phrases as cancel', () => {
    expect(classifyCancelVsUpdate('cancel')).toBe('cancel');
    expect(classifyCancelVsUpdate('please stop it')).toBe('cancel');
    expect(classifyCancelVsUpdate('abort now')).toBe('cancel');
    expect(classifyCancelVsUpdate('kill the run')).toBe('cancel');
    expect(classifyCancelVsUpdate('halt everything')).toBe('cancel');
    expect(classifyCancelVsUpdate('nevermind')).toBe('cancel');
    expect(classifyCancelVsUpdate('never mind, forget it')).toBe('cancel');
    expect(classifyCancelVsUpdate('please end the run')).toBe('cancel');
    expect(classifyCancelVsUpdate('end it')).toBe('cancel');
  });

  it('does not misclassify hyphenated compounds as cancel (regression case)', () => {
    expect(classifyCancelVsUpdate('modify task, update the front-end validation step')).toBe('update');
    expect(classifyCancelVsUpdate('update the back-end error handling')).toBe('update');
    expect(classifyCancelVsUpdate('the deployment ran non-stop, please update the schedule')).toBe('update');
  });

  it('classifies ordinary update requests as update', () => {
    expect(classifyCancelVsUpdate('change the plan to add a review step')).toBe('update');
    expect(classifyCancelVsUpdate('modify the task to include a new field')).toBe('update');
  });
});
