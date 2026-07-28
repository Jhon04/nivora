import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { appDataDir, join } from '@tauri-apps/api/path';

import { setBaseAssets } from './asset-path';

export interface AssetGuardado {
  id: string;
  /** Nombre relativo del fichero (se guarda en el documento: portable). */
  nombre: string;
  /** Ruta absoluta en disco (por si se necesita puntualmente). */
  ruta: string;
  /** Nombre de la miniatura ligera (null si no se generó). */
  preview?: string | null;
}

/** Imagen leída del disco en crudo: bytes en base64 y extensión (sin punto). */
export interface ImagenLeida {
  datos: string;
  ext: string;
}

@Injectable({ providedIn: 'root' })
export class AssetsService {
  /** Fija la carpeta base de assets (Workspace/assets) para resolver nombres
   *  relativos al mostrarlos. Llamar una vez al iniciar la app. */
  async iniciar(): Promise<void> {
    const base = await join(await appDataDir(), 'Workspace', 'assets');
    setBaseAssets(base);
  }

  /** Guarda un asset a partir de sus bytes (base64). */
  guardar(datosBase64: string, ext: string): Promise<AssetGuardado> {
    return invoke<AssetGuardado>('guardar_asset', { datosBase64, ext });
  }

  /** Importa un asset leyendo un fichero del disco por su ruta. */
  importarDesdeRuta(ruta: string): Promise<AssetGuardado> {
    return invoke<AssetGuardado>('importar_asset', { ruta });
  }

  /** Lee una imagen del disco SIN guardarla (para editarla antes de insertarla). */
  leerImagen(ruta: string): Promise<ImagenLeida> {
    return invoke<ImagenLeida>('leer_imagen', { ruta });
  }
}
