'use strict';

const { createClient } = require('@libsql/client');

function splitStatements(sql) {
    const out = [];
    let start = 0, quote = null, escaped = false;
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (quote) {
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { escaped = true; continue; }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
        if (ch === ';') {
            const part = sql.slice(start, i).trim();
            if (part) out.push(part);
            start = i + 1;
        }
    }
    const tail = sql.slice(start).trim();
    if (tail) out.push(tail);
    return out;
}

function normalizeSql(sql) {
    return String(sql)
        // Los casts de PostgreSQL se quitan primero, antes de renombrar tipos (si no, ::double precision queda como ::REAL).
        .replace(/::(?:uuid\[\]|uuid|text\[\]|text|bigint|double\s+precision|real|numeric|boolean|integer|int)\b/gi, '')
        .replace(/\bTIMESTAMPTZ\b/gi, 'TEXT')
        .replace(/\bTIMESTAMP\b/gi, 'TEXT')
        .replace(/\bDOUBLE PRECISION\b/gi, 'REAL')
        .replace(/\bBIGSERIAL\b/gi, 'INTEGER')
        .replace(/\bSERIAL\b/gi, 'INTEGER')
        .replace(/\bUUID\b/gi, 'TEXT')
        .replace(/\bTEXT\[\]/gi, 'TEXT')
        .replace(/DEFAULT\s*'\{\}'/gi, "DEFAULT '[]'")
        .replace(/(ALTER\s+TABLE\s+[^;]+?\s+ADD\s+COLUMN)\s+IF\s+NOT\s+EXISTS/gi, '$1')
        .replace(/\bNOW\(\)/gi, 'CURRENT_TIMESTAMP')
        .replace(/\s+FOR\s+UPDATE(?:\s+OF\s+[\w.,\s]+?)?(?=\s*(?:;|$|\)|\bLIMIT\b|\bORDER\b))/gi, '')
        .replace(/\bGREATEST\s*\(/gi, 'MAX(')
        .replace(/\bLEAST\s*\(/gi, 'MIN(')
        .replace(/\bIS\s+DISTINCT\s+FROM\b/gi, 'IS NOT')
        .replace(/\bILIKE\b/gi, 'LIKE')
        .replace(/INTERVAL\s*'1 day'/gi, "'1 day'")
        .replace(/CURRENT_TIMESTAMP\s*-\s*'1 day'/gi, "datetime('now', '-1 day')");
}

function bind(sql, values = []) {
    const ordered = [];
    const text = normalizeSql(sql).replace(/\$(\d+)/g, (_, n) => {
        ordered.push(values[Number(n) - 1]);
        return '?';
    });
    return { sql: text, args: ordered };
}

function resultOf(result) {
    const rows = Array.isArray(result.rows) ? result.rows : [];
    return { rows, rowCount: Number(result.rowsAffected || 0) || rows.length, rowsAffected: Number(result.rowsAffected || 0), command: '' };
}

function makeQuery(executor) {
    return async (sql, values = []) => {
        const statements = splitStatements(String(sql));
        let last = { rows: [], rowCount: 0, rowsAffected: 0 };
        for (const statement of statements) {
            const bound = bind(statement, values);
            if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(bound.sql.trim())) continue;
            try {
                last = resultOf(await executor.execute({ sql: bound.sql, args: bound.args }));
            } catch (error) {
                // SQLite no admite ADD COLUMN IF NOT EXISTS; al repetir el arranque,
                // una columna ya creada no debe impedir que la API suba.
                if (/^ALTER\s+TABLE/i.test(bound.sql) && /duplicate column|already exists/i.test(String(error.message))) continue;
                throw error;
            }
        }
        return last;
    };
}

function createTursoPool(url, authToken) {
    const db = createClient({ url, authToken });
    const pool = {
        query: makeQuery(db),
        async connect() {
            const tx = await db.transaction('write');
            const query = async (sql, values = []) => {
                const raw = String(sql).trim();
                if (/^BEGIN\b/i.test(raw)) return { rows: [], rowCount: 0, rowsAffected: 0 };
                if (/^COMMIT\b/i.test(raw)) { await tx.commit(); return { rows: [], rowCount: 0, rowsAffected: 0 }; }
                if (/^ROLLBACK\b/i.test(raw)) { await tx.rollback(); return { rows: [], rowCount: 0, rowsAffected: 0 }; }
                return makeQuery(tx)(sql, values);
            };
            return {
                query,
                release() { /* libSQL transaction is committed by COMMIT/ROLLBACK calls */ }
            };
        },
        async close() { db.close(); }
    };
    return pool;
}

module.exports = { createTursoPool };
