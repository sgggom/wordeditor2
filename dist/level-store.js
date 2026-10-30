const DATABASE_NAME = "fangge.level-library.v1";
const STORE_NAME = "levels";
const LISTS_STORE = "levelLists";
const SETTINGS_STORE = "librarySettings";
const DEFAULT_LIST = "default";
const listOf = record => record.listId ?? DEFAULT_LIST;
let databasePromise;

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 2);
      request.onupgradeneeded = event => {
        const database = request.result;
        if (event.oldVersion < 1) database.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
        if (event.oldVersion < 2) {
          database.createObjectStore(LISTS_STORE, { keyPath: "id" }).add({ id: DEFAULT_LIST,
            name: event.oldVersion ? "原有关卡列表" : "默认关卡列表", createdAt: Date.now() });
          database.createObjectStore(SETTINGS_STORE, { keyPath: "key" }).add({ key: "activeListId", value: DEFAULT_LIST });
        }
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

async function transact(mode, operation, { scoped = true } = {}) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME, LISTS_STORE, SETTINGS_STORE], mode);
    const store = transaction.objectStore(STORE_NAME);
    const lists = transaction.objectStore(LISTS_STORE);
    const settings = transaction.objectStore(SETTINGS_STORE);
    let activeListId;
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
        try {
          let value = pending.result;
          if (scoped && pending.source === store) {
            if (Array.isArray(value)) value = value.filter(record => listOf(record) === activeListId);
            else if (value && typeof value === "object" && "level" in value && listOf(value) !== activeListId) value = undefined;
          }
          onSuccess(value);
        } catch (error) { fail(error); }
      };
    };
    request(settings.get("activeListId"), saved => {
      activeListId = saved?.value ?? DEFAULT_LIST;
      operation(store, request, value => { result = value; }, activeListId, { lists, settings });
    });
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
  return transact("readwrite", (store, request, done, listId) => {
    if (existingRecord) {
      request(store.get(existingRecord.id), current => {
        if (!current) throw new Error("关卡已被删除，请刷新重试。");
        const record = { ...current, listId, level: snapshot };
        request(store.put(record), () => done(record));
      });
    } else {
      request(store.getAll(), records => {
        const position = records.reduce((maximum, record) => Math.max(maximum, positionOf(record)), 0) + 1;
        const record = { listId, createdAt: Date.now(), position, level: snapshot };
        request(store.add(record), id => done({ ...record, id }));
      });
    }
  });
}

export function saveLevelAtPosition(level, position) {
  if (!Number.isSafeInteger(position) || position < 1) throw new Error("关卡位置需为正整数。");
  const snapshot = structuredClone(level);
  return transact("readwrite", (store, request, done, listId) => {
    request(store.getAll(), records => {
      const current = ordered(records)[position - 1] ?? records.findLast(record => record.level.sourceConfig?.position === position);
      if (current) {
        const record = { ...current, listId, level: snapshot };
        request(store.put(record), () => done(record));
      } else {
        const nextPosition = records.reduce((maximum, record) => Math.max(maximum, positionOf(record)), 0) + 1;
        const record = { listId, createdAt: Date.now(), position: nextPosition, level: snapshot };
        request(store.add(record), id => done({ ...record, id }));
      }
    });
  });
}

export function deleteSavedLevel(id) {
  return transact("readwrite", (store, request, done, listId) => {
    request(store.getAll(), records => {
      if (!records.some(record => record.id === id)) throw new Error("当前列表中没有该关卡，请刷新重试。");
      request(store.delete(id), () => done(ordered(records.filter(record => record.id !== id))));
    });
  });
}

export function importSavedLevels(levels) {
  if (!Array.isArray(levels) || !levels.length) throw new Error("没有可导入的关卡。");
  const snapshots = structuredClone(levels);
  return transact("readwrite", (store, request, done, listId) => {
    request(store.getAll(), records => {
      const position = records.reduce((maximum, record) => Math.max(maximum, positionOf(record)), 0);
      const added = [];
      for (const [index, level] of snapshots.entries()) {
        const record = { listId, createdAt: Date.now(), position: position + index + 1, level };
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
  return transact("readwrite", (store, request, done, listId) => {
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


export function getSavedLevelLists() {
  return transact("readonly", (store, request, done, activeListId, { lists }) => {
    request(lists.getAll(), catalog => request(store.getAll(), records => {
      done({ activeListId, lists: catalog.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name))
        .map(list => ({ ...list, count: records.filter(record => listOf(record) === list.id).length })) });
    }));
  }, { scoped: false });
}

export function createSavedLevelList(name) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 40) throw new Error("列表名称需为 1～40 个字符。");
  name = name.trim();
  return transact("readwrite", (store, request, done, activeListId, { lists, settings }) => {
    request(lists.getAll(), catalog => {
      if (catalog.some(list => list.name.toLowerCase() === name.toLowerCase())) throw new Error("已有同名关卡列表。");
      const list = { id: crypto.randomUUID(), name, createdAt: Date.now() };
      request(lists.add(list));
      request(settings.put({ key: "activeListId", value: list.id }));
      done(list);
    });
  });
}

export function switchSavedLevelList(id) {
  return transact("readwrite", (store, request, done, activeListId, { lists, settings }) => {
    request(lists.get(id), list => {
      if (!list) throw new Error("关卡列表不存在，请刷新重试。");
      request(settings.put({ key: "activeListId", value: id }));
      done(list);
    });
  });
}

export function deleteSavedLevelList(id) {
  return transact("readwrite", (store, request, done, activeListId, { lists, settings }) => {
    request(lists.getAll(), catalog => {
      if (!catalog.some(list => list.id === id)) throw new Error("关卡列表不存在，请刷新重试。");
      if (catalog.length < 2) throw new Error("至少保留一个关卡列表。");
      request(store.getAll(), records => {
        for (const record of records) if (listOf(record) === id) request(store.delete(record.id));
        request(lists.delete(id));
        const next = id === activeListId ? catalog.find(list => list.id !== id).id : activeListId;
        request(settings.put({ key: "activeListId", value: next }));
        done(next);
      });
    });
  }, { scoped: false });
}
