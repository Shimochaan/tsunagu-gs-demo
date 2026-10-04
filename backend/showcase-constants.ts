export const SHOWCASE_TENANT = "showcase-company";
export const SHOWCASE_OA = "showcase-sales";
export const SHOWCASE_USER = "showcase-viewer";
export const SHOWCASE_USER_DDL = `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,emailVerified INTEGER NOT NULL,image TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL)`;
