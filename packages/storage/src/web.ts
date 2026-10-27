import Dexie, { Table } from 'dexie';
import type { Note, Folder, Attachment } from '@supernoti/core';

export class SuperNotiDB extends Dexie {
  notes!: Table<Note, string>;
  folders!: Table<Folder, string>;
  attachments!: Table<Attachment, string>;

  constructor() {
    super('SuperNotiDB');
    this.version(1).stores({
      notes: 'id, folderId, title, updatedAt, deletedAt',
      folders: 'id, parentId, updatedAt',
      attachments: 'id, noteId, createdAt',
    });
  }
}

export const db = new SuperNotiDB();
