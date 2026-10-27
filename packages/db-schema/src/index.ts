import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const folders = sqliteTable('folders', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  parentId: text('parent_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  folderId: text('folder_id'),
  title: text('title').notNull(),
  content: text('content').notNull(),
  plainText: text('plain_text').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
  syncedAt: integer('synced_at'),
});

export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  noteId: text('note_id').notNull(),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  key: text('key').notNull(),
  url: text('url'),
  createdAt: integer('created_at').notNull(),
});
