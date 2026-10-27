export class SyncEngine {
  constructor(private apiUrl: string) {}
  
  async sync() {
    return { success: true };
  }
}
