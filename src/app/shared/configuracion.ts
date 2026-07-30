import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { open as abrirEnSistema } from '@tauri-apps/plugin-shell';

import { EstadoSincro, RepoGitHub, SincroService } from '../core/sincro.service';
import { TemaService } from '../core/tema.service';
import { BovedasService } from '../core/bovedas.service';
import { MINIMO_CLAVE, SecretosService } from '../core/secretos.service';

/** Secciones del diálogo (la lista de la izquierda). */
type Seccion = 'cuenta' | 'secretos' | 'apariencia' | 'workspace';

/**
 * Estados por los que pasa la sección de cuenta. Es una sola pantalla que va
 * cambiando, no varias:
 *
 *   fuera → esperando → dentro → (crear | conectar) → conectado
 */
type EstadoCuenta = 'fuera' | 'esperando' | 'dentro' | 'creando' | 'eligiendo' | 'conectado';

@Component({
  selector: 'app-configuracion',
  standalone: true,
  imports: [FormsModule, MatDialogModule, MatButtonModule],
  templateUrl: './configuracion.html',
  styleUrl: './configuracion.scss',
})
export class ConfiguracionDialog implements OnInit {
  protected readonly sincro = inject(SincroService);
  protected readonly tema = inject(TemaService);
  protected readonly bovedas = inject(BovedasService);
  protected readonly secretos = inject(SecretosService);
  private readonly ref = inject(MatDialogRef<ConfiguracionDialog>);

  protected readonly seccion = signal<Seccion>('cuenta');
  protected readonly estadoRepo = signal<EstadoSincro | null>(null);

  /** Código del device flow mientras el usuario lo aprueba en el navegador. */
  protected readonly codigo = signal<{ codigoUsuario: string; url: string } | null>(null);
  protected readonly copiado = signal(false);

  /** Repos del usuario, para el segundo equipo. */
  protected readonly repos = signal<RepoGitHub[]>([]);
  protected readonly cargandoRepos = signal(false);

  /** Nombre propuesto al crear el repositorio (siempre se crea privado). */
  protected readonly nombreRepo = signal('mis-notas');

  protected readonly ocupado = signal(false);
  protected readonly aviso = signal<string | null>(null);

  /**
   * En qué punto del proceso estamos. Se deriva del estado real (sesión +
   * remoto configurado) en vez de guardarse aparte, para que no puedan
   * desincronizarse.
   */
  protected readonly estado = computed<EstadoCuenta>(() => {
    if (this.codigo()) return 'esperando';
    if (!this.sincro.usuario()) return 'fuera';
    if (this.estadoRepo()?.remoto) return 'conectado';
    return this.paso();
  });

  /** Sub-estado cuando hay sesión pero aún no hay repositorio. */
  private readonly paso = signal<EstadoCuenta>('dentro');

  // --- secretos ---
  protected readonly minimo = MINIMO_CLAVE;
  protected readonly claveActual = signal('');
  protected readonly claveNueva = signal('');
  protected readonly claveRepetir = signal('');
  protected readonly rotando = signal(false);
  protected readonly rotadas = signal<number | null>(null);

  async ngOnInit(): Promise<void> {
    await Promise.all([
      this.refrescarEstado(),
      this.sincro.cargarSesion(),
      this.secretos.cargarEstado().catch(() => undefined),
    ]);
  }

  protected async bloquearSecretos(): Promise<void> {
    await this.secretos.bloquear();
  }

  /** Cambia la contraseña maestra y recifra todos los bloques. */
  protected async rotarClave(): Promise<void> {
    if (this.claveNueva().length < MINIMO_CLAVE) {
      this.aviso.set(`La contraseña nueva necesita al menos ${MINIMO_CLAVE} caracteres.`);
      return;
    }
    if (this.claveNueva() !== this.claveRepetir()) {
      this.aviso.set('Las dos contraseñas nuevas no coinciden.');
      return;
    }
    this.aviso.set(null);
    this.rotando.set(true);
    try {
      const n = await this.secretos.rotar(this.claveActual(), this.claveNueva());
      this.rotadas.set(n);
      this.claveActual.set('');
      this.claveNueva.set('');
      this.claveRepetir.set('');
      await this.secretos.cargarEstado();
    } catch (e) {
      this.aviso.set(String(e).replace(/^Error:\s*/, ''));
    } finally {
      this.rotando.set(false);
    }
  }

  private async refrescarEstado(): Promise<void> {
    try {
      this.estadoRepo.set(await this.sincro.estado());
    } catch {
      this.estadoRepo.set(null);
    }
  }

  // ------------------------------------------------------------ sesión

  protected async entrar(): Promise<void> {
    this.aviso.set(null);
    this.ocupado.set(true);
    try {
      const c = await this.sincro.iniciarSesion();
      this.codigo.set({ codigoUsuario: c.codigoUsuario, url: c.url });
      // Se abre el navegador solo: si no, hay que copiar la URL a mano.
      void abrirEnSistema(c.url).catch(() => undefined);
      // Esta espera dura lo que el usuario tarde en aprobar.
      await this.sincro.esperarAprobacion();
      this.codigo.set(null);
      this.paso.set('dentro');
      await this.refrescarEstado();
    } catch (e) {
      this.codigo.set(null);
      this.aviso.set(String(e));
    } finally {
      this.ocupado.set(false);
    }
  }

  protected async salir(): Promise<void> {
    await this.sincro.cerrarSesion();
    this.paso.set('dentro');
    this.aviso.set(null);
  }

  protected async copiarCodigo(): Promise<void> {
    const c = this.codigo();
    if (!c) return;
    try {
      await navigator.clipboard.writeText(c.codigoUsuario);
      this.copiado.set(true);
      setTimeout(() => this.copiado.set(false), 1500);
    } catch {
      // Sin portapapeles: el código está a la vista, se puede teclear.
    }
  }

  protected abrirGitHub(): void {
    const c = this.codigo();
    if (c) void abrirEnSistema(c.url).catch(() => undefined);
  }

  // ------------------------------------------------------------ repositorio

  protected irACrear(): void {
    this.aviso.set(null);
    this.paso.set('creando');
  }

  protected async irAElegir(): Promise<void> {
    this.aviso.set(null);
    this.paso.set('eligiendo');
    this.cargandoRepos.set(true);
    try {
      this.repos.set(await this.sincro.listarRepos());
    } catch (e) {
      this.aviso.set(String(e));
    } finally {
      this.cargandoRepos.set(false);
    }
  }

  protected volver(): void {
    this.aviso.set(null);
    this.paso.set('dentro');
  }

  protected async crear(): Promise<void> {
    const nombre = this.nombreRepo().trim();
    if (!nombre) return;
    this.aviso.set(null);
    this.ocupado.set(true);
    try {
      await this.sincro.crearRepo(nombre);
      await this.refrescarEstado();
    } catch (e) {
      this.aviso.set(String(e));
    } finally {
      this.ocupado.set(false);
    }
  }

  protected async conectar(repo: RepoGitHub): Promise<void> {
    this.aviso.set(null);
    this.ocupado.set(true);
    try {
      const r = await this.sincro.conectarRepo(repo.url);
      await this.refrescarEstado();
      // El listado de la app se queda viejo si han llegado notas nuevas.
      if (r.cambios) this.ref.close('recargar');
    } catch (e) {
      this.aviso.set(String(e));
    } finally {
      this.ocupado.set(false);
    }
  }

  protected async sincronizarAhora(): Promise<void> {
    this.aviso.set(null);
    this.ocupado.set(true);
    try {
      const r = await this.sincro.sincronizarSiProcede();
      await this.refrescarEstado();
      if (r?.cambios) this.ref.close('recargar');
    } catch (e) {
      this.aviso.set(String(e));
    } finally {
      this.ocupado.set(false);
    }
  }

  protected async desconectar(): Promise<void> {
    await this.sincro.desconectar();
    this.paso.set('dentro');
    await this.refrescarEstado();
  }

  // ------------------------------------------------------------ presentación

  /** `https://github.com/ana/mis-notas.git` → `ana/mis-notas`. */
  protected readonly repoCorto = computed(() => {
    const url = this.estadoRepo()?.remoto ?? '';
    return url.replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '') || url;
  });

  protected readonly ultimaSincro = computed(() => {
    const d = this.sincro.ultima() ?? this.fechaUltimoCommit();
    if (!d) return 'nunca';
    const min = Math.floor((Date.now() - d.getTime()) / 60000);
    if (min < 1) return 'hace un momento';
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `hace ${h} h`;
    return d.toLocaleDateString();
  });

  private fechaUltimoCommit(): Date | null {
    const iso = this.estadoRepo()?.ultimoCommit;
    return iso ? new Date(iso) : null;
  }

  protected cerrar(): void {
    this.ref.close();
  }
}
