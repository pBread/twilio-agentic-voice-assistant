import { EventEmitter } from "node:events";

export class TypedEventEmitter<Events = {}> extends EventEmitter {
  emit = <K extends keyof Events & (string | symbol)>(
    event: K,
    ...args: Parameters<
      Events[K] extends (...args: any[]) => any ? Events[K] : never
    >
  ): boolean => super.emit(event, ...args);

  on = <K extends keyof Events & (string | symbol)>(
    event: K,
    listener: Events[K] extends (...args: any[]) => any ? Events[K] : never
  ): this => super.on(event, listener);
}

type VersionedObject = { version: number };

export function createVersionedObject<T extends VersionedObject>(
  baseObject: T,
  emitUpdate: () => void
): T {
  return new Proxy(
    baseObject,
    createVersionedHandler<T>(baseObject, emitUpdate)
  );
}

function createVersionedHandler<T extends object>(
  parentObject: VersionedObject,
  emitUpdate: () => void
): ProxyHandler<T> {
  return {
    get(target: any, prop: string | symbol) {
      const value = target[prop];

      // Handle array methods that modify the array
      if (Array.isArray(target)) {
        const arrayMethodHandler = createArrayMethodHandler(
          target,
          prop,
          parentObject,
          emitUpdate
        );
        if (arrayMethodHandler) return arrayMethodHandler;
      }

      // Recursively wrap objects and arrays
      if (typeof value === "object" && value !== null) {
        return new Proxy(
          value,
          createVersionedHandler(parentObject, emitUpdate)
        );
      }

      return value;
    },

    set(target: any, prop: string | symbol, value: any) {
      // Don't wrap the version property itself
      if (target === parentObject && prop === "version") {
        target[prop] = value;
        emitUpdate();
        return true;
      }

      // Handle nested objects and arrays
      if (typeof value === "object" && value !== null) {
        target[prop] = Array.isArray(value)
          ? [...value] // Create a new array to proxy
          : { ...value }; // Create a new object to proxy

        target[prop] = new Proxy(
          target[prop],
          createVersionedHandler(parentObject, emitUpdate)
        );
      } else {
        target[prop] = value;
      }

      // Increment version and emit update
      parentObject.version++;
      emitUpdate();
      return true;
    },

    deleteProperty(target: any, prop: string | symbol) {
      delete target[prop];
      parentObject.version++;
      emitUpdate();
      return true;
    },
  };
}

function createArrayMethodHandler(
  array: any[],
  prop: string | symbol,
  parentObject: VersionedObject,
  emitUpdate: () => void
) {
  const modifyingMethods = {
    push: (...items: any[]) => {
      const result = Array.prototype.push.apply(array, items);
      parentObject.version++;
      emitUpdate();
      return result;
    },
    pop: () => {
      const result = Array.prototype.pop.apply(array);
      parentObject.version++;
      emitUpdate();
      return result;
    },
    shift: () => {
      const result = Array.prototype.shift.apply(array);
      parentObject.version++;
      emitUpdate();
      return result;
    },
    unshift: (...items: any[]) => {
      const result = Array.prototype.unshift.apply(array, items);
      parentObject.version++;
      emitUpdate();
      return result;
    },
    splice: (
      ...args: [start: number, deleteCount: number, ...items: any[]]
    ) => {
      const result = Array.prototype.splice.apply(array, args);
      parentObject.version++;
      emitUpdate();
      return result;
    },
    sort: (compareFn?: (a: any, b: any) => number) => {
      const result = Array.prototype.sort.apply(array, [compareFn]);
      parentObject.version++;
      emitUpdate();
      return result;
    },
    reverse: () => {
      const result = Array.prototype.reverse.apply(array);
      parentObject.version++;
      emitUpdate();
      return result;
    },
  };

  return modifyingMethods[prop as keyof typeof modifyingMethods];
}
