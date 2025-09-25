import React, { useEffect, useState, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from 'recharts';

// Esta aplicación es un componente de React en un solo archivo.
// Utiliza sql.js (compilado a WASM) para ejecutar una base de datos SQLite en el navegador.
// Permite pegar un esquema SQL, validarlo, ejecutar pruebas de inserción masiva y
// visualizar los resultados para analizar la escalabilidad.

export default function App() {
  const [SQL, setSQL] = useState(null); // Contendrá la librería sql.js
  const [db, setDb] = useState(null);
  const [schemaText, setSchemaText] = useState(
`-- Pega tu esquema SQL aquí
-- Ejemplo básico (útil para probar):
CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, email TEXT, created_at DATETIME);
`);
  const [messages, setMessages] = useState([]);
  const [testRunning, setTestRunning] = useState(false);
  const [rowsToInsert, setRowsToInsert] = useState(5000);
  const [batchSize, setBatchSize] = useState(500);
  const [chartData, setChartData] = useState([]);
  const [lastReport, setLastReport] = useState(null);
  const [queryText, setQueryText] = useState('SELECT name, type, tbl_name FROM sqlite_master WHERE type IN (\'table\') LIMIT 100;');
  const [queryResult, setQueryResult] = useState(null);
  const logRef = useRef([]);

  // Ubicaciones en CDN para sql.js (versión WASM)
  const SQLJS_VERSION = '1.6.2';
  const SQLJS_BASE = `https://cdnjs.cloudflare.com/ajax/libs/sql.js/${SQLJS_VERSION}`;
  const SQLJS_JS = `${SQLJS_BASE}/sql-wasm.js`;
  const SQLJS_WASM = `${SQLJS_BASE}/sql-wasm.wasm`;

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (!window.initSqlJs) {
          await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = SQLJS_JS;
            s.async = true;
            s.onload = () => resolve();
            s.onerror = (ev) => reject(new Error('No se pudo cargar sql-wasm.js desde el CDN.'));
            document.head.appendChild(s);
          });
        }

        const SQLlib = await window.initSqlJs({
          locateFile: (file) => SQLJS_WASM
        });

        if (!mounted) return;
        setSQL(SQLlib);
        appendMsg('sql.js (WASM) cargado correctamente desde CDN.');
      } catch (e) {
        appendMsg('Error cargando sql.js (WASM): ' + String(e));
      }
    })();

    return () => { mounted = false; };
  }, []);

  function appendMsg(msg) {
    logRef.current = [{ ts: new Date().toLocaleTimeString(), text: msg }, ...logRef.current].slice(0, 200);
    setMessages([...logRef.current]);
  }

  async function initDatabase() {
    if (!SQL) return appendMsg('sql.js no está listo aún. Esperando carga del WASM...');
    try {
      const database = new SQL.Database();
      setDb(database);
      appendMsg('Base de datos en memoria creada.');
    } catch (e) {
      appendMsg('Error creando la base de datos: ' + String(e));
    }
  }

  function resetDatabase() {
    if (db) {
      try {
        db.close();
      } catch (e) {}
      setDb(null);
    }
    setChartData([]);
    setLastReport(null);
    setQueryResult(null);
    appendMsg('Base de datos reiniciada.');
  }

  async function validateSchema() {
    if (!SQL) return appendMsg('sql.js no está listo.');
    const database = new SQL.Database();
    try {
      database.run(schemaText);
      const res = database.exec("PRAGMA integrity_check;");
      const ok = (res && res[0] && res[0].values && res[0].values[0] && res[0].values[0][0]) || 'unknown';
      appendMsg(`Esquema aplicado. PRAGMA integrity_check => ${ok}`);
      setDb(database);
      return { ok: ok === 'ok', raw: ok };
    } catch (e) {
      appendMsg('Error aplicando el esquema: ' + String(e));
      try { database.close(); } catch(_){ }
      return { ok: false, error: String(e) };
    }
  }

  function randomValueForType(colDef, i) {
    const lower = (colDef || '').toLowerCase();
    if (lower.includes('int')) return i;
    if (lower.includes('char') || lower.includes('text') || lower.includes('clob')) return `'name_${i}'`;
    if (lower.includes('date') || lower.includes('time')) return `'2025-09-24 00:00:00'`;
    if (lower.includes('real') || lower.includes('float') || lower.includes('double') || lower.includes('numeric')) return (Math.random()*100).toFixed(2);
    return `'v_${i}'`;
  }

  function parseTablesFromSchema(schema) {
    const creates = schema.match(/create\s+table[\s\S]*?;|create\s+table[\s\S]*?$/ig);
    if (!creates) return [];
    return creates.map(stmt => {
      const nameMatch = stmt.match(/create\s+table\s+(if\s+not\s+exists\s+)?([`\"]?)([a-zA-Z0-9_]+)\2/i);
      const name = nameMatch ? nameMatch[3] : 'unknown';
      const colsMatch = stmt.replace(/\n/g,' ').match(/\((.*)\)/s);
      let cols = [];
      if (colsMatch && colsMatch[1]) {
        const parts = colsMatch[1].split(/,(?![^()]*\))/g).map(s=>s.trim()).filter(Boolean);
        parts.forEach(p => {
          const m = p.match(/^([`\"]?)([a-zA-Z0-9_]+)\1\s+([a-zA-Z0-9_()\s]+)/);
          if (m) cols.push({ name: m[2], type: m[3].trim() });
        });
      }
      return { name, cols };
    });
  }

  async function runScalabilityTest() {
    if (!db) {
      appendMsg('Necesitas validar el esquema primero para crear la base de datos.');
      return;
    }
    setTestRunning(true);
    setChartData([]);
    const tables = parseTablesFromSchema(schemaText);
    if (tables.length === 0) {
      appendMsg('No se detectaron tablas en el esquema.');
      setTestRunning(false);
      return;
    }
    appendMsg(`Tablas detectadas: ${tables.map(t=>t.name).join(', ')}. Usando la primera: ${tables[0].name}`);

    const targetTable = tables[0];
    if (targetTable.cols.length === 0) {
      appendMsg('La tabla seleccionada no tiene columnas detectables para generar datos.');
      setTestRunning(false);
      return;
    }

    const total = Number(rowsToInsert) || 1000;
    const batch = Number(batchSize) || 100;
    const iterations = Math.ceil(total / batch);
    let inserted = 0;
    const results = [];
    const errors = [];

    for (let it = 0; it < iterations; it++) {
      const start = performance.now();
      try {
        db.run('BEGIN;');
        for (let j = 0; j < batch && inserted < total; j++) {
          const i = inserted + 1;
          const cols = targetTable.cols.map(c => c.name).join(', ');
          const vals = targetTable.cols.map(c => randomValueForType(c.type, i)).join(', ');
          const insertSQL = `INSERT INTO ${targetTable.name} (${cols}) VALUES (${vals});`;
          db.run(insertSQL);
          inserted++;
        }
        db.run('COMMIT;');
        const duration = performance.now() - start;
        results.push({ batch: it+1, insertedSoFar: inserted, batchSize: Math.min(batch, total - (it*batch)), ms: Math.round(duration) });
        appendMsg(`Batch ${it+1}: insertados ${inserted}/${total} (tiempo: ${Math.round(duration)} ms)`);
        setChartData(prev => [...prev, { x: inserted, y: Math.round(duration) }]);
      } catch (e) {
        try { db.run('ROLLBACK;'); } catch(_){ }
        errors.push({ batch: it+1, error: String(e) });
        appendMsg(`Error en batch ${it+1}: ${String(e)}`);
        break;
      }
      await new Promise(r => setTimeout(r, 10));
    }

    setTestRunning(false);
    const report = { totalAttempted: total, totalInserted: inserted, batches: results, errors };
    setLastReport(report);
    appendMsg('Prueba finalizada. ' + JSON.stringify({ insertados: inserted, errores: errors.length }));
  }

  function formatQueryResult(res) {
    if (!res || res.length === 0) return { cols: [], values: [] };
    return { cols: res[0].columns, values: res[0].values };
  }

  function runQuery() {
    if (!db) return appendMsg('No hay una base de datos cargada.');
    try {
      const res = db.exec(queryText);
      setQueryResult(formatQueryResult(res));
      appendMsg(`Query ejecutada. Filas devueltas: ${res[0] ? res[0].values.length : 0}`);
    } catch (e) {
      appendMsg('Error ejecutando query: ' + String(e));
      setQueryResult(null);
    }
  }

  function downloadReport() {
    const report = {
      schema: schemaText,
      timestamp: new Date().toISOString(),
      lastReport,
      chartData,
      messages: messages.slice(0,50).reverse(),
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sql_validator_report.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="p-6 min-h-screen bg-gray-50 font-sans">
      <div className="max-w-6xl mx-auto bg-white rounded-2xl shadow-lg p-6 grid grid-cols-1 md:grid-cols-12 gap-6">
        <div className="md:col-span-5">
          <h1 className="text-2xl font-bold mb-2 text-gray-800">Validador de Esquema SQL</h1>
          <p className="text-sm text-gray-600 mb-4">Pega tu esquema, valida y ejecuta pruebas de inserción para medir la escalabilidad en el navegador.</p>

          <label htmlFor="schema-area" className="block text-sm font-medium text-gray-700">Esquema SQL</label>
          <textarea id="schema-area" value={schemaText} onChange={e=>setSchemaText(e.target.value)} rows={12}
            className="w-full mt-2 p-3 border border-gray-300 rounded-md font-mono text-sm focus:ring-2 focus:ring-blue-500"></textarea>

          <div className="flex flex-wrap gap-2 mt-3">
            <button onClick={initDatabase} className="px-3 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors">Crear DB</button>
            <button onClick={()=>{ resetDatabase(); initDatabase(); }} className="px-3 py-2 bg-yellow-500 text-white rounded-md hover:bg-yellow-600 transition-colors">Reiniciar DB</button>
            <button onClick={validateSchema} className="px-3 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors">Validar Esquema</button>
            <button onClick={downloadReport} className="px-3 py-2 bg-gray-700 text-white rounded-md hover:bg-gray-800 transition-colors">Descargar Reporte</button>
          </div>

          <div className="mt-4 border-t pt-4">
            <h2 className="font-semibold text-gray-800">Parámetros de Prueba</h2>
            <div className="grid grid-cols-2 gap-3 mt-2">
              <div>
                <label htmlFor="rows-input" className="text-sm text-gray-600">Filas totales</label>
                <input id="rows-input" type="number" value={rowsToInsert} onChange={e=>setRowsToInsert(e.target.value)} className="w-full p-2 border border-gray-300 rounded-md mt-1" />
              </div>
              <div>
                <label htmlFor="batch-input" className="text-sm text-gray-600">Tamaño de batch</label>
                <input id="batch-input" type="number" value={batchSize} onChange={e=>setBatchSize(e.target.value)} className="w-full p-2 border border-gray-300 rounded-md mt-1" />
              </div>
            </div>
            <div className="flex gap-2 mt-3">
              <button onClick={runScalabilityTest} disabled={testRunning} className="w-full px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:bg-indigo-300 transition-colors">{testRunning? 'Ejecutando prueba...' : 'Ejecutar Prueba de Escalabilidad'}</button>
              <button onClick={()=>{ setChartData([]); setLastReport(null); appendMsg('Resultados limpiados.'); }} className="px-4 py-2 bg-red-500 text-white rounded-md hover:bg-red-600 transition-colors">Limpiar</button>
            </div>
          </div>

        </div>

        <div className="md:col-span-7">
          <div className="grid grid-cols-1 gap-4">
            <div className="p-4 border border-gray-200 rounded-lg">
              <h2 className="font-semibold text-gray-800">Gráfico de Latencia por Batch</h2>
              <div style={{ width: '100%', height: 260 }} className="mt-2">
                {chartData.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-gray-400">Sin datos. Ejecuta una prueba para ver el gráfico.</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="x" name="Filas Insertadas" />
                      <YAxis label={{ value: 'ms', angle: -90, position: 'insideLeft' }} />
                      <Tooltip formatter={(value, name) => [value, 'Tiempo (ms)']}/>
                      <Line type="monotone" dataKey="y" name="Tiempo (ms)" stroke="#4f46e5" dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            <div className="p-4 border border-gray-200 rounded-lg">
              <h2 className="font-semibold text-gray-800">Ejecutar Query Manual</h2>
              <textarea value={queryText} onChange={e=>setQueryText(e.target.value)} rows={3} className="w-full p-2 mt-2 border border-gray-300 rounded-md font-mono text-sm focus:ring-2 focus:ring-sky-500"></textarea>
              <div className="flex gap-2 mt-2">
                <button onClick={runQuery} className="px-3 py-2 bg-sky-600 text-white rounded-md hover:bg-sky-700 transition-colors">Ejecutar</button>
                <button onClick={()=>{ setQueryText('SELECT name, type, tbl_name FROM sqlite_master;'); setQueryResult(null); }} className="px-3 py-2 bg-gray-300 text-gray-800 rounded-md hover:bg-gray-400 transition-colors">Ejemplo</button>
              </div>

              <div className="mt-3 overflow-auto max-h-48">
                {queryResult ? (
                  <table className="table-auto w-full text-sm">
                    <thead className="sticky top-0 bg-gray-50">
                      <tr>{queryResult.cols.map(c=> <th key={c} className="px-2 py-1 text-left border-b border-gray-300 font-medium">{c}</th>)}</tr>
                    </thead>
                    <tbody>
                      {queryResult.values.map((r,ri)=> (
                        <tr key={ri} className="hover:bg-gray-100">{r.map((cell,ci)=>(<td key={ci} className="px-2 py-1 border-b border-gray-200">{String(cell)}</td>))}</tr>
                      ))}
                    </tbody>
                  </table>
                ) : (<div className="text-gray-500 text-center py-4">Sin resultados para mostrar.</div>)}
              </div>
            </div>

            <div className="p-4 border border-gray-200 rounded-lg grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <h3 className="font-semibold text-gray-800">Último Reporte</h3>
                <pre className="text-xs max-h-48 overflow-auto bg-gray-50 p-2 rounded mt-2 border">{lastReport ? JSON.stringify(lastReport, null, 2) : 'No hay reporte aún.'}</pre>
              </div>

              <div>
                <h3 className="font-semibold text-gray-800">Mensajes / Log</h3>
                <div className="text-xs max-h-48 overflow-auto bg-gray-50 p-2 rounded mt-2 border">
                  {messages.map((m, idx) => (<div key={idx} className="font-mono"><span className="text-gray-400">[{m.ts}]</span> {m.text}</div>))}
                </div>
              </div>
            </div>

          </div>
        </div>

      </div>

      <footer className="max-w-6xl mx-auto mt-4 text-center text-sm text-gray-500">
        <p>Tip: Para pruebas de escalabilidad, define índices en tu esquema y experimenta con diferentes tamaños de batch.</p>
      </footer>
    </div>
  );
}