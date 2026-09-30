'use strict';

const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'trip-files';
const FOLDER_MARKER = '.keep'; // empty placeholder object so an empty folder still appears in listings

let client;
function getClient() {
  if (!client) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
    }
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return client;
}

// Supabase Storage keys must be ASCII-only — confirmed by testing directly
// against a real bucket, Thai (and any non-ASCII) names are rejected outright
// with "Invalid key". Each path SEGMENT is base64url-encoded independently
// (not the whole path) so '/' still works as a real folder separator, and
// the display name round-trips exactly through encode -> decode.
const encodeSegment = (name) => Buffer.from(name, 'utf8').toString('base64url');
const decodeSegment = (seg) => {
  try { return Buffer.from(seg, 'base64url').toString('utf8'); }
  catch { return seg; }
};

function encodePath(displayPath) {
  return displayPath.split('/').filter(Boolean).map(encodeSegment).join('/');
}

function joinKey(displayPath, segmentName) {
  const base = encodePath(displayPath);
  return (base ? base + '/' : '') + encodeSegment(segmentName);
}

/** Folders and files at one level of a DISPLAY path ('' = root). */
async function list(displayPath) {
  const key = encodePath(displayPath);
  const { data, error } = await getClient().storage.from(BUCKET)
    .list(key, { sortBy: { column: 'name', order: 'asc' } });
  if (error) throw new Error(error.message);

  const folders = [];
  const files = [];
  for (const item of data) {
    if (item.name === FOLDER_MARKER) continue; // the placeholder itself is an implementation detail
    const name = decodeSegment(item.name);
    if (item.id === null) {
      folders.push({ name, type: 'folder' });
    } else {
      files.push({
        name, type: 'file',
        size: item.metadata?.size ?? null,
        updatedAt: item.updated_at,
        mimeType: item.metadata?.mimetype ?? null,
      });
    }
  }
  return { folders, files };
}

async function createFolder(displayPath, folderName) {
  const key = joinKey(displayPath, folderName) + '/' + FOLDER_MARKER;
  const { error } = await getClient().storage.from(BUCKET)
    .upload(key, new Blob(['']), { upsert: false });
  if (error) throw new Error(error.message);
}

/** The browser PUTs its file directly to this URL — never passes through our
    own function, so Vercel's ~4.5MB body-size limit never applies to uploads. */
async function createUploadUrl(displayPath, fileName) {
  const key = joinKey(displayPath, fileName);
  const { data, error } = await getClient().storage.from(BUCKET).createSignedUploadUrl(key);
  if (error) throw new Error(error.message);
  return { signedUrl: data.signedUrl, token: data.token, path: data.path };
}

async function createDownloadUrl(displayPath, fileName, expiresInSec = 3600) {
  const key = joinKey(displayPath, fileName);
  const { data, error } = await getClient().storage.from(BUCKET).createSignedUrl(key, expiresInSec);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

async function deleteFile(displayPath, fileName) {
  const key = joinKey(displayPath, fileName);
  const { error } = await getClient().storage.from(BUCKET).remove([key]);
  if (error) throw new Error(error.message);
}

async function listAllKeysRecursive(prefixKey) {
  const { data, error } = await getClient().storage.from(BUCKET).list(prefixKey);
  if (error) throw new Error(error.message);
  let keys = [];
  for (const item of data) {
    const itemKey = prefixKey + '/' + item.name;
    if (item.id === null) keys = keys.concat(await listAllKeysRecursive(itemKey));
    else keys.push(itemKey);
  }
  return keys;
}

/** Deletes a folder and everything inside it, recursively. */
async function deleteFolder(displayPath, folderName) {
  const folderKey = joinKey(displayPath, folderName);
  const allKeys = await listAllKeysRecursive(folderKey);
  if (allKeys.length) {
    const { error } = await getClient().storage.from(BUCKET).remove(allKeys);
    if (error) throw new Error(error.message);
  }
}

module.exports = { list, createFolder, createUploadUrl, createDownloadUrl, deleteFile, deleteFolder };
