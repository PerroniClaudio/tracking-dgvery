import dotenv from 'dotenv';
import fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import mysql from "@fastify/mysql";
import fastifyIO from 'fastify-socket.io';
import mysql2, {RowDataPacket, Connection} from 'mysql2/promise';
import closeWithGrace from 'close-with-grace';


dotenv.config();

declare module 'fastify' {
    interface FastifyInstance {
      mysql: {
        getConnection: () => Promise<Connection>;
      };
    }
}

const PORT = parseInt(process.env.PORT || '3001');
const HOST = process.env.HOST || '0.0.0.0';
const CORS_ORIGIN  = process.env.CORS_ORIGIN || 'http://localhost:3000';

interface TrackingElement {
    module_id: string;
    timestamp: string;
    current_progress: number;
}
  
interface ModuleElement {
    module_id: string;
    timestamp: string;
    current_progress: number;
}


const domainConnectionPools: Record<string, mysql2.Pool> = {};

async function buildServer() {
    const app = fastify();

    await app.register(fastifyCors, {
        origin: CORS_ORIGIN,
    });

    await app.register(fastifyIO)

    await app.register(mysql, {
        promise: true,
        connectionString: process.env.DATABASE_URL,
    });

    async function getClientConnection(name: string) {
        const mainConnection = await app.mysql.getConnection();
        const [result, _] = await mainConnection.query<RowDataPacket[]>('SELECT * FROM domains WHERE name = ?', [name]);

        const config: RowDataPacket[] = Array.isArray(result) ? result : [];

        if(config.length > 0) {

            const clientConfig = JSON.parse(config[0]['config']);
        
            if (!domainConnectionPools[name]) {
                domainConnectionPools[name] = mysql2.createPool({
                    user: clientConfig.USER,
                    password: clientConfig.PASSWORD,
                    host: clientConfig.HOST,
                    database: clientConfig.DB,
                    connectionLimit: 10,
                });
            }
        
            const connection = await domainConnectionPools[name].getConnection();
        
            return connection;

        } else {
            return null;
        }
    }

    app.io.on('connection', async (io) => {
        let clientConnection: mysql2.PoolConnection | null = null;
        let lastTimestamp: string | null = null;
        let user: string | null = null;
        let domain: string | null = null;

        io.on('create-connection', async (payload) => {
          clientConnection = await getClientConnection(payload.domain);
          user = payload.user;
          domain = payload.domain;
        });
       
        io.on('video:update-tracking', async (payload  : TrackingElement) => {

            if( (!clientConnection) || (!user) ) { 
                return;
            }

            const [result, _] = await clientConnection.query<RowDataPacket[]>(`SELECT * FROM courses_modules, courses_modules_usr WHERE courses_modules.cmoid = ? AND courses_modules.cmoid = courses_modules_usr.cmoid AND courses_modules_usr.uid = ?`, [payload.module_id, user]);
            
            const modules: RowDataPacket[] = Array.isArray(result) ? result : [];

            if(modules.length > 0) {
            
                const item = modules[0];

                if(lastTimestamp) {

                    let oldTimestamp = new Date(lastTimestamp);
                    let newTimestamp = new Date(payload.timestamp);

                    let timestampDifference = (newTimestamp.getTime() - oldTimestamp.getTime()) / 1000;

                    await clientConnection.query(
                        `UPDATE courses_modules_usr SET current_progress = ?, timespent = (timespent + ?) WHERE uid = ? AND cmoid = ?`,
                        [payload.current_progress, timestampDifference, user, payload.module_id]
                    );

                } else {

                    await clientConnection.query(
                        `UPDATE courses_modules_usr SET current_progress = ? WHERE uid = ? AND cmoid = ?`,
                        [payload.current_progress, user, payload.module_id]
                    );

                }
            
                lastTimestamp = payload.timestamp;
            
            }
         
        });

        io.on('disconnect', () => {
            console.log('disconnected', io.id);
            if (clientConnection) {
              // Rilascia la connessione al pool per il dominio specifico
              if (domain && domainConnectionPools[domain]) {
                domainConnectionPools[domain].releaseConnection(clientConnection);
              }
            }
        })

    });


    app.get('/healthcheck', () => {
        return {
            status: 'ok',
            port: PORT,
        }
    })


    return app;
}

async function main() {
    const app = await buildServer();

    try {

        await app.listen({
            port: PORT,
            host: HOST,
        });

        closeWithGrace({
            delay: 500,
        }, async () => {
            console.log('Shutting down...');
            await app.close();
        });


        console.log(`Server is running on http://${HOST}:${PORT}`);
        
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}

main();