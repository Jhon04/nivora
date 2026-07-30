import { Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

/** Usuario de GitHub con la sesión iniciada. */
export interface UsuarioGitHub {
  login: string;
  nombre: string | null;
  avatar: string | null;
}

/** Código que el usuario teclea en github.com/login/device. */
export interface CodigoDispositivo {
  codigoUsuario: string;
  url: string;
  caducaEn: number;
}

/**
 * Qué OAuth App se está usando para iniciar sesión.
 *
 * La app trae la suya y no hay nada que configurar; esto existe para quien
 * prefiera **no depender de la OAuth App de nadie** y registre la propia.
 */
export interface EstadoClientId {
  /** El que se usa ahora mismo. */
  efectivo: string;
  /** El que se guardó en este equipo, si se guardó alguno. */
  propio: string | null;
  /** `NIVORA_CLIENT_ID` manda sobre lo demás: el campo no serviría de nada. */
  porEntorno: boolean;
  /** Ninguno propio: se usa el que trae la app. */
  porDefecto: boolean;
}

export interface RepoGitHub {
  nombre: string;
  completo: string;
  url: string;
  privado: boolean;
}

export interface EstadoSincro {
  iniciado: boolean;
  remoto: string | null;
  pendientes: number;
  ultimoCommit: string | null;
}

/** Nota bloqueada que alguien cambió y ha vuelto a su sitio. */
export interface NotaRestaurada {
  id: string;
  titulo: string;
  /** Fichero donde quedó la versión ajena, si la había. */
  copia: string | null;
}

export interface ResultadoSincro {
  cambios: boolean;
  conflictos: string[];
  restauradas: NotaRestaurada[];
  notas: number;
}

/**
 * Cuenta de GitHub y sincronización del workspace.
 *
 * El **token nunca llega hasta aquí**: vive en el llavero del sistema y solo lo
 * maneja Rust. Este servicio únicamente sabe si hay sesión y de quién es.
 */
@Injectable({ providedIn: 'root' })
export class SincroService {
  /** Usuario con sesión, o `null`. */
  readonly usuario = signal<UsuarioGitHub | null>(null);
  /** Hay una sincronización en marcha (para el indicador de la UI). */
  readonly sincronizando = signal(false);
  /** Última sincronización correcta. */
  readonly ultima = signal<Date | null>(null);
  /** Notas que quedaron con una versión en conflicto. */
  readonly conflictos = signal<string[]>([]);
  /**
   * Notas bloqueadas que alguien cambió y se han devuelto a su sitio.
   *
   * Va aparte de `conflictos` a propósito: un conflicto es que dos personas
   * editaron a la vez, esto es que alguien tocó lo que no debía. Merecen avisos
   * distintos.
   */
  readonly restauradas = signal<NotaRestaurada[]>([]);
  /** Último fallo de sincronización, si lo hubo. */
  readonly error = signal<string | null>(null);

  /** Comprueba la sesión guardada (valida el token contra GitHub). */
  async cargarSesion(): Promise<UsuarioGitHub | null> {
    const u = await invoke<UsuarioGitHub | null>('github_sesion');
    this.usuario.set(u);
    return u;
  }

  iniciarSesion(): Promise<CodigoDispositivo> {
    return invoke<CodigoDispositivo>('github_iniciar_sesion');
  }

  /** Espera a que el usuario apruebe en el navegador. Puede tardar minutos. */
  async esperarAprobacion(): Promise<UsuarioGitHub> {
    const u = await invoke<UsuarioGitHub>('github_esperar_aprobacion');
    this.usuario.set(u);
    return u;
  }

  async cerrarSesion(): Promise<void> {
    await invoke<void>('github_cerrar_sesion');
    this.usuario.set(null);
  }

  /** Qué Client ID se está usando y de dónde sale. */
  estadoClientId(): Promise<EstadoClientId> {
    return invoke<EstadoClientId>('github_estado_client_id');
  }

  /**
   * Guarda un Client ID propio, o vuelve al de la app con `null`.
   *
   * Cierra la sesión siempre —lo hace Rust—, porque el token guardado lo emitió
   * la OAuth App anterior y con otra no vale.
   */
  async fijarClientId(id: string | null): Promise<EstadoClientId> {
    const estado = await invoke<EstadoClientId>('github_fijar_client_id', { id });
    this.usuario.set(null);
    return estado;
  }

  listarRepos(): Promise<RepoGitHub[]> {
    return invoke<RepoGitHub[]>('github_listar_repos');
  }

  estado(): Promise<EstadoSincro> {
    return invoke<EstadoSincro>('estado_sincro');
  }

  /**
   * Crea el repositorio y sube las notas de este equipo (primer equipo).
   * **Siempre privado**: no es configurable a propósito, ver `github.rs`.
   */
  crearRepo(nombre: string): Promise<RepoGitHub> {
    return this.conRegistro(() => invoke<RepoGitHub>('crear_repo', { nombre }));
  }

  /** Conecta con un repositorio existente y trae las notas (segundo equipo). */
  conectarRepo(url: string): Promise<ResultadoSincro> {
    return this.conRegistro(() => invoke<ResultadoSincro>('conectar_repo', { url }));
  }

  desconectar(): Promise<void> {
    return invoke<void>('desconectar_repo');
  }

  /**
   * Sincroniza si hay sesión y repositorio. Devuelve `null` si no tocaba
   * hacerlo, para que quien la llama (arranque, autoguardado) no tenga que
   * comprobarlo cada vez.
   */
  async sincronizarSiProcede(): Promise<ResultadoSincro | null> {
    if (!this.usuario() || this.sincronizando()) return null;
    const estado = await this.estado();
    if (!estado.remoto) return null;
    return this.conRegistro(() => invoke<ResultadoSincro>('sincronizar'));
  }

  /** Envuelve una operación de red llevando el indicador y los errores. */
  private async conRegistro<T>(op: () => Promise<T>): Promise<T> {
    this.sincronizando.set(true);
    this.error.set(null);
    try {
      const res = await op();
      this.ultima.set(new Date());
      const r = res as { conflictos?: string[]; restauradas?: NotaRestaurada[] };
      if (r?.conflictos?.length) {
        this.conflictos.update((c) => [...c, ...r.conflictos!]);
      }
      if (r?.restauradas?.length) {
        // Se acumulan sin repetir: si la misma nota se restaura en varias
        // sincronizaciones seguidas, el aviso no debe multiplicarse.
        this.restauradas.update((prev) => {
          const vistos = new Set(prev.map((n) => n.id));
          return [...prev, ...r.restauradas!.filter((n) => !vistos.has(n.id))];
        });
      }
      return res;
    } catch (e) {
      this.error.set(String(e));
      throw e;
    } finally {
      this.sincronizando.set(false);
    }
  }
}
