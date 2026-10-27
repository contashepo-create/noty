export type User = {
  id: string;
  username: string;
};

export type Folder = {
  id: string;
  name: string;
  parentId?: string;
  createdAt: number;
  updatedAt: number;
};

export type Note = {
  id: string;
  folderId?: string;
  title: string;
  content: string; // HTML from TipTap
  plainText: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  syncedAt?: number;
};

export type Attachment = {
  id: string;
  noteId: string;
  filename: string;
  mimeType: string;
  size: number;
  key: string; // R2 key
  url?: string;
  createdAt: number;
};

export type SyncChange = {
  id: string;
  type: "note" | "folder" | "attachment";
  action: "create" | "update" | "delete";
  data: any;
  timestamp: number;
};
