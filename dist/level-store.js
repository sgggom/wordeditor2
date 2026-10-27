const DATABASE_NAME = "fangge.level-library.v1";
const STORE_NAME = "levels";
let databasePromise;

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          databasePromise = null;
        };
        resolve(database);
      };
    }).catch(error => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

async function transact(mode, operation) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    let result;
    let failure;
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("关卡列表存储失败。"));
    const fail = error => {
      failure = error;
      transaction.abort();
    };
    const request = (pending, onSuccess = () => {}) => {
      pending.onsuccess = () => {
        try { onSuccess(pending.result); } catch (error) { fail(error); }
      };
    };
    try {
      operation(transaction.objectStore(STORE_NAME), request, value => { result = value; });
    } catch (error) {
      fail(error);
    }
  });
}

// Legacy records have no explicit position and retain their original ID order.
const positionOf = record => record.position ?? record.id;
const ordered = records => records.sort((a, b) => positionOf(a) - positionOf(b) || a.id - b.id);

export function getSavedLevels() {
  return transact("readonly", (store, request, done) => {
    request(store.getAll(), records => done(ordered(records)));
  });
}

export async function saveLevel(level, existingRecord = null) {
  const snapshot = structuredClone(level);
  return transact("readwrite", (store, request, done) => {
    if (existingRecord) {
      request(store.get(existingRecord.id), current => {
        if (!current) throw new Error("关卡已被删除，请刷新重试。");
        const record = { ...current, level: snapshot };
        request(store.put(record), () => done(record));
      });
    } else {
      request(store.getAll(), records => {
        const position = records.reduce((maximum, record) => Math.max(maximum, positionOf(record)), 0) + 1;
        const record = { createdAt: Date.now(), position, level: snapshot };
        request(store.add(record), id => done({ ...record, id }));
      });
    }
  });
}

export function deleteSavedLevel(id) {
  return transact("readwrite", (store, request, done) => {
    request(store.getAll(), records => {
      request(store.delete(id), () => done(ordered(records.filter(record => record.id !== id))));
    });
  });
}

export function importSavedLevels(levels) {
  if (!Array.isArray(levels) || !levels.length) throw new Error("没有可导入的关卡。");
  const snapshots = structuredClone(levels);
  return transact("readwrite", (store, request, done) => {
    request(store.getAll(), records => {
      const position = records.reduce((maximum, record) => Math.max(maximum, positionOf(record)), 0);
      const added = [];
      for (const [index, level] of snapshots.entries()) {
        const record = { createdAt: Date.now(), position: position + index + 1, level };
        request(store.add(record), id => {
          added.push({ ...record, id });
          if (added.length === snapshots.length) done(ordered([...records, ...added]));
        });
      }
    });
  });
}

export function moveSavedLevel(id, direction) {
  if (direction !== -1 && direction !== 1) throw new Error("关卡移动方向无效。");
  return transact("readwrite", (store, request, done) => {
    request(store.getAll(), records => {
      ordered(records);
      const index = records.findIndex(record => record.id === id);
      if (index < 0) throw new Error("关卡已被删除，请刷新重试。");
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= records.length) {
        done(records);
        return;
      }
      const current = records[index];
      const neighbor = records[nextIndex];
      records[nextIndex] = { ...current, position: positionOf(neighbor) };
      records[index] = { ...neighbor, position: positionOf(current) };
      request(store.put(records[nextIndex]));
      request(store.put(records[index]));
      done(records);
    });
  });
}
