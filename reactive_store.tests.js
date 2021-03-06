import ReactiveStore from 'meteor/jmaric:deep-reactive-store';
import { Tracker } from 'meteor/tracker';
import assert from 'assert';

const nextFlush = () => new Promise(resolve => Tracker.afterFlush(resolve));

describe('ReactiveStore', () => {
    describe('#get', () => {
        it('should reactively get root dep', async (done) => {
            try {
                const test = new ReactiveStore();

                let currentVal, ran = 0;

                Tracker.autorun((computation) => {
                    const newVal = test.get();

                    if (!computation.firstRun) {
                        currentVal = newVal;
                        ran++;
                    }
                });

                // Root value should be reset to null and autorun should run once
                test.set(null);
                await nextFlush();
                assert.equal(ran, 1);
                assert.equal(currentVal, null);
                assert.equal(currentVal, test.data);
                
                // Root value should be reset to { test: { deep: true } } and autorun should run once
                currentVal = undefined;
                ran = 0;

                test.set({ test: { deep: true } });
                await nextFlush();
                assert.equal(ran, 1);
                assert.deepEqual(currentVal, { test: { deep: true } });
                assert.deepEqual(currentVal, test.data);

                // Both deep fields should be set and autorun should run once
                currentVal = undefined;
                ran = 0;

                test.assign({ 
                    'test.another.prop': true,
                    'another.deep.field': 1
                });
                await nextFlush();
                assert.equal(ran, 1);
                assert.deepEqual(currentVal, {
                    test: { deep: true, another: { prop: true } },
                    another: { deep: { field: 1 } }
                });
                assert.deepEqual(currentVal, test.data);
                
                // currentVal should remain unchanged and autorun should not run
                ran = 0;

                test.assign({ 
                    'test': { deep: true, another: { prop: true } },
                    'another.deep': { field: 1 }
                });
                await nextFlush();
                assert.equal(ran, 0);
                assert.deepEqual(currentVal, {
                    test: { deep: true, another: { prop: true } },
                    another: { deep: { field: 1 } }
                });
                assert.deepEqual(currentVal, test.data);

                // Should delete both deep fields and autorun should run once
                currentVal = undefined;
                ran = 0;

                test.delete('test.another.prop', 'another.deep.field');
                await nextFlush();
                assert.equal(ran, 1);
                assert.deepEqual(currentVal, {
                    test: { deep: true, another: {} },
                    another: { deep: {} }
                });
                assert.deepEqual(currentVal, test.data);

                // Should reset root value to {} and autorun should run once
                currentVal = undefined;
                ran = 0;

                test.clear();
                await nextFlush();
                assert.equal(ran, 1);
                assert.deepEqual(currentVal, {});
                assert.deepEqual(currentVal, test.data);               

                done();

            } catch (error) {
                done(error);
            }
        });
    });
});
