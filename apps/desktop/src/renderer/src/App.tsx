import Editor from "./components/Editor";

export default function App() {
  return (
    <div className="flex h-screen">
      <aside className="w-64 border-r bg-gray-50 p-4">
        <h1 className="text-xl font-semibold mb-4">SuperNoti</h1>
        <button className="w-full text-left px-2 py-1 hover:bg-gray-200 rounded mb-2">+ New Note</button>
        <button className="w-full text-left px-2 py-1 hover:bg-gray-200 rounded">All Notes</button>
      </aside>
      <main className="flex-1 p-6">
        <div className="max-w-4xl mx-auto">
          <input className="w-full text-3xl font-bold mb-4 outline-none border-none" placeholder="Untitled" />
          <Editor />
        </div>
      </main>
    </div>
  );
}
