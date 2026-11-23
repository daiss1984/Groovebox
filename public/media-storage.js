export function transactionRequest(database, table, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(table, mode);
    const firstTable = Array.isArray(table) ? table[0] : table;
    let error;
    let request;
    transaction.onerror = event => { error ||= event.target.error; };
    transaction.onabort = () => reject(transaction.error || error || new Error('IndexedDB transaction aborted'));
    transaction.oncomplete = () => resolve(request?.result);
    try {
      request = operation(transaction.objectStore(firstTable), transaction);
    } catch (failure) {
      error = failure;
      transaction.abort();
    }
  });
}

export function needsBinaryFallback(error) {
  return error?.name === 'DataCloneError' ||
    (error?.name === 'UnknownError' && /Blob\/File data/i.test(error.message));
}

export async function toBinary(blob) {
  return blob ? { buffer: await blob.arrayBuffer(), type: blob.type } : undefined;
}

export function binaryBlob(binary) {
  return binary ? new Blob([binary.buffer], { type: binary.type }) : undefined;
}
