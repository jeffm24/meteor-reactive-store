import { Tracker } from 'meteor/tracker';
import {
    isObject,
    isSpacebarsKw,
    useStrictEqualityCheck,
    ensureDepNode,
    setsAreEqual
} from './helpers';
 
/**
 * @typedef path - Dot-notated store path.
 * @type {string}
 * 
 * @typedef DepNode - Dependency node object.
 * @type {Object}
 * @property {Tracker.Dependency} [dep] - Tracker dependency associated with this node.
 * @property {Object.<string, DepNode>} subDeps - Map of subKeys -> subDepNodes
 * 
 * @typedef Mutator - Assignment mutator function.
 * @type {Function}
 * @param {any} value - Assigned value
 * @param {ReactiveStore} store - Current ReactiveStore instance
 * @returns {any} Mutated value
 */

const Blaze = (Package.blaze) ? Package.blaze.Blaze : {};

/**
 * @class ReactiveStore
 */
export default class ReactiveStore {
    /**
     * @param {Object} [config] - Initial store configuration
     * @param {Function} [config.data] - Function that returns the initial root value.
     * @param {Object.<path, Mutator>} [config.mutators] - path -> Mutator map
     * @param {Object.<string, Function>} [config.methods] - methodName -> Function map
     */
    constructor(config = {}) {
        const { data, mutators, methods } = config;

        this.updateMutators(mutators);
        this.updateMethods(methods);
        
        this._changeData = { deps: new Set(), opCount: 0 };
        this._pathData = new Map();
        this._noMutate = false;
        this._methods = {};

        ensureDepNode(this, ReactiveStore.ROOT);

        // Initialize data
        this._initData = (data instanceof Function) ? data : () => {};       
        this.data = this._initData();
        this._isTraversable = ReactiveStore.isTraversable(this.data);

        // Parse initial data for computed values
        if (this._isTraversable) {
            ReactiveStore.parse(this.data, (path, value) => {
                if (value instanceof Function && value[ReactiveStore.COMPUTED] === true) {
                    value = this.setComputation(path, value);
                }

                return value;
            });
        }

        // If store was initialized within a Blaze view, automatically stop all computations when the view is destroyed
        const { currentView } = Blaze;

        if (currentView) {
            const stopComputationsOnDestroyed = () => {
                this.stopComputations().then(() => {
                    currentView.removeViewDestroyedListener(stopComputationsOnDestroyed);
                });
            };

            currentView.onViewDestroyed(stopComputationsOnDestroyed);
        }
    }

    // Symbol that represents the 'path' to the root value
    static ROOT = Symbol('ROOT_STORE_PATH');

    // Symbol that can be assigned to path to delete it from the store (also used internally to represent non-existent value)
    static DELETE = Symbol('DELETE_STORE_PATH');

    // Symbol that can be returned from a mutator to cancel the assign/delete operation
    static CANCEL = Symbol('CANCEL_STORE_ASSIGNMENT');

    // Symbol that marks a value that would normally be traversable as non-traversable
    static SHALLOW = Symbol('SHALLOW_STORE_DATA');

    // Symbol that marks an assign function as computed
    static COMPUTED = Symbol('COMPUTED_STORE_DATA');

    // Map of constructors to equality check functions
    static eqCheckMap = new Map([
        [
            Set, setsAreEqual
        ], [
            Date, function (oldDate, newDate) {
                return (
                    newDate instanceof Date
                    && oldDate.getTime() === newDate.getTime()
                );
            }
        ], [
            RegExp, function (oldRegex, newRegex) {
                return (
                    newRegex instanceof RegExp
                    && oldRegex.source === newRegex.source
                    && setsAreEqual(
                        new Set(oldRegex.flags),
                        new Set(newRegex.flags)
                    )
                );
            }
        ]
    ]);

    // Abstract path class
    static Abstract = class Abstract {
        constructor(store, path) {
            this._store = store;
            this._basePath = String(path);
            this._pathCache = {};
        }
    
        get(subPath) {
            const path = (subPath)
                ? this._getPath(subPath)
                : this._basePath;
    
            return this._store.get(path);
        }
    
        equals(...params) {
            let path, value;
    
            if (params.length > 1 && !isSpacebarsKw(params[1])) {
                // Two-parameter config
                path = this._getPath(params[0]);
                ({ 1: value } = params);
            } else {
                // One-parameter config
                path = this._basePath;
                ({ 0: value } = params);
            }
    
            return this._store.equals(path, value);
        }
    
        exists() {
            return this._store.has(this._basePath);
        }
    
        has(subPath) {
            return this._store.has(this._getPath(subPath));
        }
    
        set(value) {
            this._store.assign(this._basePath, value);
        }
    
        assign(...params) {
            const pathValueMap = {};
            
            if (params.length > 1 && !isSpacebarsKw(params[1])) {
                // Two-parameter config
                const [subPath, value] = params;
    
                pathValueMap[this._getPath(subPath)] = value;
            } else {
                // One-parameter config
                const [subPathValueMap] = params;
    
                if (isObject(subPathValueMap)) {
                    for (const [subPath, value] of Object.entries(subPathValueMap)) {
                        pathValueMap[this._getPath(subPath)] = value;
                    }
                }
            }
    
            this._store.assign(pathValueMap);
        }
    
        delete(...subPaths) {            
            this._store.delete(...subPaths.map(subPath => this._getPath(subPath)));
        }
    
        _getPath(subPath) {
            const { _pathCache } = this;
    
            if (!_pathCache[subPath]) {
                _pathCache[subPath] = `${this._basePath}.${subPath}`;
            }
    
            return _pathCache[subPath];
        }
    };

    // Add custom equality check for instances of the given constuctor
    static addEqualityCheck(constructor, isEqual) {
        if (!(constructor instanceof Function) || !(isEqual instanceof Function) || isEqual.length !== 2) {
            throw new Error('You must provide a valid constructor function/class and an equality check function that takes two parameters (oldValue, newValue).');
        }

        ReactiveStore.eqCheckMap.set(constructor, isEqual);
    }

    // Remove custom equality check for instances of the given constuctor
    static removeEqualityCheck(constructor) {
        ReactiveStore.eqCheckMap.delete(constructor);
    }

    // Returns true if the given value is traversable (is Object/Array and doesn't have ReactiveStore.SHALLOW as a key set to a truthy value)
    static isTraversable(value) {
        return (isObject(value) || Array.isArray(value)) && !value[ReactiveStore.SHALLOW];
    }

    // If value is traversable, mark it with the ReactiveStore.SHALLOW Symbol so that it not anymore
    static shallow(value) {
        if (ReactiveStore.isTraversable(value)) {
            // Use Object.defineProperty so that property is not enumerable
            Object.defineProperty(value, ReactiveStore.SHALLOW, { value: true });
        }

        return value;
    }

    // If value is a function, mark it with the ReactiveStore.COMPUTED Symbol to flag it for computation
    static computed(value) {
        if (value instanceof Function) {
            // Use Object.defineProperty so that property is not enumerable
            Object.defineProperty(value, ReactiveStore.COMPUTED, { value: true });
        }

        return value;
    }

    // Traverse down all traversable in the given obj and call the given function for each key/val pair
    static parse(obj, func, path) {
        if (ReactiveStore.isTraversable(obj)) {
            for (const [key, value] of Object.entries(obj)) {
                const currentPath = (path ? `${path}.${key}` : key);

                obj[key] = func(currentPath, value);
                ReactiveStore.parse(obj[key], func, currentPath);
            }
        }
    }

    // Return obj[key] if obj is traversable and key is an enumerable property within it; otherwise, return ReactiveStore.DELETE to indicate nonexistant value
    static _valueAtKey(obj, key) {
        const keyExists = (ReactiveStore.isTraversable(obj) && obj.propertyIsEnumerable(key));
        return keyExists ? obj[key] : ReactiveStore.DELETE;
    }

    /**
     * Get value at path (and register dependency if reactive)
     * @param {path} [path] - Path of store value.
     * @returns {any} Current value at path.
     */
    get(path = ReactiveStore.ROOT) {
        const { depNode, value } = this._findProperty(path);

        if (Tracker.active) {
            // Ensure that valueDep exists and depend on it
            if (!depNode.valueDep) {
                depNode.valueDep = new Tracker.Dependency();
            }

            depNode.valueDep.depend();
        }

        return value;
    }

    /**
     * Get existence of path (and register dependency if reactive)
     * @param {path} path - Store path to check.
     * @returns {boolean} Existence of path. 
     */
    has(path) {
        const { depNode, exists } = this._findProperty(path);

        if (Tracker.active) {
            // Ensure that existsDep exists and depend on it
            if (!depNode.existsDep) {
                depNode.existsDep = new Tracker.Dependency();
                depNode.exists = exists;
            }

            depNode.existsDep.depend();
        }

        return exists;
    }

    /**
     * @function equals - Check equality of root against comparison value (and register equality dependency if reactive)
     * 
     * @param {any} value - Comparison value.
     * @returns {boolean} Equality of the values.
     *//**
     * @function equals - Check equality of value at path against comparison value (and register equality dependency if reactive)
     * 
     * @param {path} path - Path of store value.
     * @param {any} value - Comparison value.
     * @returns {boolean} Equality of the values.
     */
    equals(...params) {
        // Interpret params based on length
        let path, value;

        if (params.length > 1 && !isSpacebarsKw(params[1])) {
            // Two-parameter config
            ([path, value] = params);
        } else {
            // One-parameter config
            path = ReactiveStore.ROOT;
            ([value] = params);
        }

        // Throw error if we can't use strict equality check for value
        if (!useStrictEqualityCheck(value)) {
            throw new Error('ReactiveStore: Only primitive values (number, string, boolean, undefined, null, symbol) and functions can be registered as equality dependencies.');
        }

        // Ensure that equality dep exists for the given value and depend on it
        const search = this._findProperty(path),
            isEqual = (search.value === value);

        if (Tracker.active) {
            const { depNode } = search;

            let eqDep;

            if (depNode.eqDepMap) {
                eqDep = depNode.eqDepMap.get(value);
            } else {
                depNode.eqDepMap = new Map();
            }            

            if (!eqDep) {
                eqDep = new Tracker.Dependency();
                depNode.eqDepMap.set(value, eqDep);
            }

            if (isEqual) {
                depNode.activeEqDep = eqDep;
            }

            eqDep.depend();
        }

        return isEqual;
    }

    /**
     * Replace the root value with the given value.
     * @param {any} value
     */
    set(value) {
        const oldValue = this.data;
        
        this._isTraversable = ReactiveStore.isTraversable(value);
        this.data = value;

        this._watchChanges(() => {
            this._triggerChangedDeps(this[ReactiveStore.ROOT], oldValue, value);
        });
    }

    /**
     * @function assign - Assign the given value at the given path.
     * 
     * @param {path} path - Path to assign value to.
     * @param {any} value - Value to assign.
     *//**
     * @function assign - Assign each value from the given path -> value map at its corresponding path.
     * 
     * @param {Object.<path, any>} pathValueMap - Object map of path -> value pairs to be assigned.
     */
    assign(...params) {
        let pathValueMap;
        
        if (params.length > 1 && !isSpacebarsKw(params[1])) {
            // Two-parameter config
            const [path, value] = params;
            pathValueMap = { [path]: value };
        } else {
            // One-parameter config
            [pathValueMap] = params;
        }

        if (isObject(pathValueMap)) {
            this._watchChanges(() => {
                for (const [path, value] of Object.entries(pathValueMap)) {
                    this._setAtPath(path, value);
                }
            });
        }
    }
    
    /**
     * Delete all of the given paths from the store.
     * @param {...path} paths - Paths to delete from the store.
     */
    delete(...paths) {
        // Only run if root value is traversable
        if (this._isTraversable) {
            this._watchChanges(() => {
                for (const path of paths) {
                    this._setAtPath(path, ReactiveStore.DELETE);
                }
            });
        }
    }

    /**
     * If root value is currently traversable, set it to a new instance of the current constructor.
     * Otherwise, set it to undefined.
     */
    clear() {
        this.set(this._isTraversable ? new this.data.constructor() : undefined);
    }

    /**
     * If there was a data function provided in the initial config, reset the root value to the value returned by that.
     * Otherwise, set it to undefined.
     */
    reset() {
        this.set(this._initData());
    }

    /**
     * Create a ReactiveVar-like object with dedicated get/equals/set/delete functions to access/modify the given path in the store.
     * Created object is cached so that repeated calls for the same path will return the same object.
     * @param {path} path - Path to create object for.
     * @returns {ReactiveStore.Abstract} object for the given path.
     */
    abstract(path) {
        const pathData = this._getPathData(path);

        if (!pathData.abstract) {
            pathData.abstract = new ReactiveStore.Abstract(this, path);
        }

        return pathData.abstract;
    }

    /**
     * 
     * @param {path} path 
     * @param {Function} value 
     */
    startComputation(path, value) {
        const pathData = this._getPathData(path);

        if (pathData.computation) {
            pathData.computation.stop();
        }

        let computedValue;

        pathData.computation = Tracker.autorun(({ firstRun }) => {
            computedValue = value();
            
            if (!firstRun) {
                this.assign({ [path]: computedValue });
            }
        });

        return computedValue;
    }

    /**
     * Stops all currently running computations.
     * @returns {Promise} Promise that resolves when all computations have stopped.
     */
    stopComputations() {
        const stopPromises = [];

        for (const pathData of this._pathData.values()) {
            const { computation } = pathData;

            if (computation) {
                delete pathData.computation;
                stopPromises.push(new Promise(resolve => computation.onStop(resolve)));
                computation.stop();
            }
        }

        return Promise.all(stopPromises);
    }

    /**
     * Update internal methods for the store
     * @param {Object.<string, Function>} methodMap - methodName -> Function map
     */
    updateMethods(methodMap) {
        if (methodMap instanceof Object) {
            for (const [methodName, methodFunction] of Object.entries(methodMap)) {
                if (methodFunction instanceof Function) {
                    this._methods[methodName] = methodFunction;
                }
            }
        }
    }

    /**
     * Delete stored methods with the given name(s).
     * @param {...string} methodNames - Names of methods to delete.
     */
    removeMethods(...methodNames) {
        for (const methodName of methodNames) {
            delete this._methods[methodName];
        }
    }

    /**
     * 
     * @param {string} methodName - Name of store method to call
     * @param  {...any} params - Params to pass to be passed to the method
     * @returns {any} Result of the method call
     */
    call(methodName, ...params) {
        if (!this._methods.hasOwnProperty(methodName)) {
            throw new Error(`Method ${methodName} is not defined.`);
        }

        return this._methods[methodName].apply(this, params);
    }

    /**
     * Update pathData map with the given mutator functions.
     * @param {Object.<path, Mutator>} mutatorMap - path -> Mutator map.
     * @param {path} [path] - Current base path to prepend to the map keys.
     */
    updateMutators(mutatorMap, path) {
        if (mutatorMap instanceof Object) {
            for (const [key, val] of Object.entries(mutatorMap)) {
                const nextPath = path ? `${path}.${key}` : key;

                if (val instanceof Function) {
                    this._getPathData(nextPath).mutate = val;
                } else {
                    this.updateMutators(val, nextPath);
                }
            }
        }
    }

    /**
     * Delete stored mutator functions for given path(s).
     * @param {...path} paths - Paths to delete mutators for.
     */
    removeMutators(...paths) {
        for (const path of paths) {
            const pathData = this._getPathData(path, false/* init */);
            if (pathData) {
                delete pathData.mutate;
            }
        }
    }

    /**
     * Sets the _noMutate flag so that any assignments that happen within the given operation will skip mutations.
     * @param {Function} op - Operation to run without mutations. 
     */
    noMutation(op) {
        this._noMutate = true;
        op();
        this._noMutate = false;
    }

    /**
     * Set value at path, creating depth where necessary, and call recursive dependency trigger helpers.
     * @param {path} path - Path to set value at.
     * @param {any} value - Value to set at path. Operation will cancel if value is ReactiveStore.CANCEL, or path will be deleted if value is ReactiveStore.DELETE.
     */
    _setAtPath(path, value) {
        const pathData = this._getPathData(path);

        // Mutate value if the _noMutate flag is not true and there is a mutate function for the path        
        if (!this._noMutate && pathData.mutate) {
            value = pathData.mutate(value, this);
        }

        // Cancel operation if value is ReactiveStore.CANCEL
        if (value === ReactiveStore.CANCEL) return;

        // Unset if value is ReactiveStore.DELETE
        const unset = (value === ReactiveStore.DELETE);

        // Coerce root data to be an Object if it is not currenty traversable
        if (!this._isTraversable) {
            // Cancel the operation if this is an unset because the path doesn't exist
            if (unset) return;

            this._isTraversable = true;
            this.data = {};
        }

        const { tokens } = pathData,
            lastTokenIdx = (tokens.length - 1),
            rootNode = this[ReactiveStore.ROOT],
            parentDepNodes = [rootNode];

        let deps = rootNode.subDeps,
            search = this.data;
            
        for (let tokenIdx = 0; tokenIdx <= lastTokenIdx; tokenIdx++) {
            const token = tokens[tokenIdx];
            
            if (tokenIdx < lastTokenIdx) {
                // Parent Token: Ensure that search[token] is traversable, step into it, and store active deps
                if (!ReactiveStore.isTraversable(search[token])) {
                    // Cancel the operation if this is an unset because the path doesn't exist
                    if (unset) return;

                    search[token] = {};
                }

                search = search[token];

                if (deps) {
                    const depNode = deps[token];

                    if (depNode) {
                        // Store parent dep node so it can be triggered after we know if targeted child property has definitely changed
                        parentDepNodes.push(depNode);                        
                        deps = depNode.subDeps;
                    } else {
                        deps = null;
                    }
                }

            } else if (!unset || search.propertyIsEnumerable(token)) {
                // Last Token: Set/Unset search at token and handle dep changes
                const depNode = deps && deps[token],
                    oldValue = search[token];

                let changed = true;
    
                if (unset) {
                    // Delete token if unset
                    delete search[token];
    
                    // Trigger dep at token and any subDeps it may have
                    if (depNode) {
                        this._triggerAllDeps(depNode.subDeps, oldValue, value);
                        this._registerChange(depNode, value);
                    }
    
                } else {
                    // Otherwise, set the new value
                    search[token] = value;
    
                    // Starting with current dep, traverse down and trigger any deps for changed vals
                    changed = this._triggerChangedDeps(depNode, oldValue, value);
                }
    
                if (changed) {
                    // Trigger any active parent dependencies that were hit
                    for (const parentDepNode of parentDepNodes) {
                        this._registerChange(parentDepNode, Object);
                    }
                }
            }
        }
    }

    /**
     * Wrapper to track changed dependencies within the given operation and then trigger all of them at once after there are no more operations pending.
     * @param {Function} op - Operation to run.
     */
    _watchChanges(op) {
        const { _changeData } = this;

        _changeData.opCount++;
        op();
        _changeData.opCount--;

        // Once there are no more ops running, trigger all changed deps and clear the set
        if (!_changeData.opCount && _changeData.deps.size) {
            for (const dep of _changeData.deps) {
                dep.changed();
            }

            _changeData.deps = new Set();
        }
    }

    /**
     * If given dep is defined, add it to the change data set to be processed after ops have completed.
     * Also process any existence/equality dependency changes that might have happened.
     * @param {DepNode} depNode - Dependency Node to register.
     * @param {any} newValue - New value at corresponding path in the store
     */
    _registerChange(depNode, newValue) {
        if (!depNode) return;
    
        const changedDepSet = this._changeData.deps,
            unset = (newValue === ReactiveStore.DELETE);

        // Trigger value dependency
        if (depNode.valueDep) {
            changedDepSet.add(depNode.valueDep);
        }

        // Check if existence dependency should be triggered 
        if (depNode.existsDep) {
            const existenceChanged = (depNode.exists ? unset : !unset);

            if (depNode.existsDep && existenceChanged) {
                changedDepSet.add(depNode.existsDep);
                depNode.exists = !depNode.exists;
            }
        }
      

        // Check if equality dependencies should be triggered
        if (depNode.eqDepMap) {
            // In terms of "value", unset and undefined are the same, so just use undefined
            const eqDep = depNode.eqDepMap.get(unset ? undefined : newValue),
                { activeEqDep } = depNode;

            if (eqDep !== activeEqDep) {
                if (eqDep) changedDepSet.add(eqDep);
                if (activeEqDep) changedDepSet.add(activeEqDep);

                depNode.activeEqDep = eqDep;
            }
        }
    }
    
    /**
     * Recursively traverse down deps and trigger all existing dependencies that are set in the keyFilter.
     * @param {Object.<string, DepNode>} deps - key -> DepNode map to traverse through.
     * @param {Object|Array} keyFilter - This will be traversed in tandem with deps and only shared keys at each level will be triggered.
     *      Traversal branches will also be stopped early if there are no more levels to traverse in keyFilter.
     * @param {any} curValue - Current value at the deps corresponding level in the store. Will be traversed in tandem if traversable.
     * @param {Set} seenTraversableSet - Used to prevent infinite recursion if keyFilter is cyclical.
     */
    _triggerAllDeps(deps, keyFilter, curValue, seenTraversableSet) {
        if (deps && ReactiveStore.isTraversable(keyFilter)) {
            if (!seenTraversableSet) {
                seenTraversableSet = new Set();
            }

            // Stop traversal if keyFilter has already been seen
            if (!seenTraversableSet.has(keyFilter)) {
                seenTraversableSet.add(keyFilter);

                for (const key of Object.keys(deps)) {
                    const curValueAtKey = ReactiveStore._valueAtKey(curValue, key);
    
                    this._registerChange(deps[key], curValueAtKey);
    
                    if (keyFilter.propertyIsEnumerable(key)) {
                        this._triggerAllDeps(deps[key].subDeps, keyFilter[key], curValueAtKey, seenTraversableSet);
                    }
                }
            }
        }
    }
    
    /**
     * Check for changes between oldValue and newValue and recursively traverse down to check/trigger
     * deep dependency changes if necessary.
     * @param {DepNode} depNode - DepNode for the current traversal level.
     * @param {any} oldValue - Old value at current traversal level.
     * @param {any} newValue - New value at current traversal level.
     * @param {Set} seenTraversableSet - Used to prevent infinite recursion if oldValue or newValue is cyclical.
     * @returns {boolean} True if value has changed.
     */
    _triggerChangedDeps(depNode, oldValue, newValue, seenTraversableSet) {
        const subDeps = depNode && depNode.subDeps;

        let newValueTraversed = false,
            changed = false;
    
        if (useStrictEqualityCheck(oldValue)) {
            // Perform strict equality check to determine change if we can
            changed = (oldValue !== newValue);

        } else if (oldValue === newValue) {
            // Cannot check for differences if oldValue and newValue are literally the same reference, so assume changed.
            changed = true;

        } else if (ReactiveStore.isTraversable(oldValue)) {
            // If oldValue is traversable...
            if (!seenTraversableSet) {
                seenTraversableSet = new Set();
            }

            if (seenTraversableSet.has(oldValue) || seenTraversableSet.has(newValue)) {
                // Assume changed if oldValue or newValue has already been seen once because cyclical data structures cannot be checked for deep changes
                changed = true;

            } else {
                // Otherwise, add oldValue to the seenTraversableSet and continue
                seenTraversableSet.add(oldValue);

                const keySet = new Set(Object.keys(oldValue));

                if (ReactiveStore.isTraversable(newValue)) {
                    // If newValue is also traversable, add it to the seenTraversableSet
                    seenTraversableSet.add(newValue);

                    // Add its keys to the keySet
                    const newValueKeys = Object.keys(newValue);

                    // Definitely changed if values don't share the same constructor or have a different amount of keys
                    if (oldValue.constructor !== newValue.constructor || keySet.size !== newValueKeys.length) {
                        changed = true;
                    }

                    // Only process newValueKeys if we don't already know of any changes, or there are subDeps to process
                    if (!changed || subDeps) {
                        // Add all newValueKeys to the keySet
                        for (const key of newValueKeys) {
                            if (!keySet.has(key)) {
                                // Definitely changed if newValue key does not exist in oldValue and its value is not undefined
                                // NOTE: The presence of a new key doesn't matter if it is set to undefined because that means the value hasn't changed.
                                if (!changed && newValue[key] !== undefined) {
                                    changed = true;
                                    if (!subDeps) break;
                                }

                                keySet.add(key);
                            }
                        }
                    }

                    // Set newValueTraversed to true so that _triggerAllDeps check below is skipped
                    newValueTraversed = true;
                    
                } else {
                    // Definitely changed if newValue is not traversable
                    changed = true;
                }

                // Only initiate further traversal if we don't already know of any changes, or there are subDeps to process
                if (!changed || subDeps) {
                    // Iterate through all unique keys between the old/new values and check for deep changes
                    for (const key of keySet) {
                        const subDepNode = subDeps && subDeps[key];
                        
                        // Only traverse if change has not been found or there is a sub-dependency to check
                        if (!changed || subDepNode) {
                            const oldValueAtKey = ReactiveStore._valueAtKey(oldValue, key),
                                newValueAtKey = ReactiveStore._valueAtKey(newValue, key),
                                valueAtKeyChanged = this._triggerChangedDeps(subDepNode, oldValueAtKey, newValueAtKey, seenTraversableSet);
                            
                            if (!changed && valueAtKeyChanged) {
                                changed = true;
                            }
                        }                        
                    }
                }
            }
            
        } else {
            // Run custom equality check for the oldValue's instance type (e.g. Set, Date, etc) if there is one
            const isEqual = ReactiveStore.eqCheckMap.get(oldValue.constructor);

            if (!isEqual || !isEqual(oldValue, newValue)) {
                changed = true;
            }
        }

        // Trigger all deep dependencies present in newValue if it has not been traversed
        if (!newValueTraversed) {
            this._triggerAllDeps(subDeps, newValue, newValue);
        }
        
        if (changed) {
            this._registerChange(depNode, newValue);
        }
    
        return changed;
    }

    /**
     * Gets the pathData object for the given path.
     * @param {path} path - Path to get data for.
     * @param {boolean} [init] - Initialize non-existent pathData if set to true.
     * @returns {Object} pathData object
     */
    _getPathData(path, init = true) {
        const { _pathData } = this;

        if (path !== ReactiveStore.ROOT) {
            path = String(path);
        }

        if (init && !_pathData.has(path)) {
            const tokens = (typeof path === 'string')
                ? path.split('.')
                : [path];

            _pathData.set(path, { tokens });
        }

        return _pathData.get(path);
    }

    /**
     * Attempt to traverse down current data on the given path creating dep nodes along the way (if reactive)
     * @param {path} path - Path to search for in the store.
     * @returns {Object} An Object containing search value and related dep node
     */
    _findProperty(path) {
        let depNode = this[ReactiveStore.ROOT],
            value = this.data,
            exists = true;

        // Don't traverse further if path is ReactiveStore.ROOT
        if (path !== ReactiveStore.ROOT) {
            const { tokens } = this._getPathData(path),
                reactive = Tracker.active;
        
            for (const token of tokens) {
                if (reactive) {
                    depNode = ensureDepNode(depNode.subDeps, token);
                }
        
                if (exists) {
                    if (ReactiveStore.isTraversable(value) && value.propertyIsEnumerable(token)) {
                        value = value[token];
                    } else {
                        value = undefined;
                        exists = false;
                        if (!reactive) break;
                    }
                }
            }
        }
    
        return { depNode, value, exists };
    }
}
