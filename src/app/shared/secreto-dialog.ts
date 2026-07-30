import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';

import { MINIMO_CLAVE, SecretosService } from '../core/secretos.service';

export interface SecretoDatos {
  etiqueta: string;
  /** Valor cifrado que se está editando, o '' si es nuevo. */
  datos: string;
}

export interface SecretoResultado {
  etiqueta: string;
  datos: string;
}

/**
 * Pide (y cifra) el valor de un bloque secreto.
 *
 * Toda la pantalla existe para que **el texto en claro no pase por el
 * documento**: se escribe aquí, se cifra en Rust y lo que sale es ya el valor
 * cifrado. Si el usuario cierra sin aceptar, no queda rastro en ningún sitio.
 */
@Component({
  selector: 'app-secreto-dialog',
  standalone: true,
  imports: [FormsModule, MatDialogModule, MatButtonModule],
  templateUrl: './secreto-dialog.html',
  styleUrl: './secreto-dialog.scss',
})
export class SecretoDialog {
  protected readonly secretos = inject(SecretosService);
  private readonly ref = inject(MatDialogRef<SecretoDialog, SecretoResultado>);
  protected readonly datos = inject<SecretoDatos>(MAT_DIALOG_DATA);

  protected readonly etiqueta = signal(this.datos.etiqueta);
  protected readonly valor = signal('');
  protected readonly contrasena = signal('');
  protected readonly repetir = signal('');
  protected readonly ocupado = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly editando = !!this.datos.datos;
  protected readonly minimo = MINIMO_CLAVE;

  /**
   * Qué toca pedir ahora. Se deriva del estado real en vez de guardarse aparte
   * para que no puedan desincronizarse.
   */
  protected readonly paso = computed<'crear-clave' | 'desbloquear' | 'valor'>(() => {
    if (!this.secretos.configurado()) return 'crear-clave';
    if (!this.secretos.desbloqueado()) return 'desbloquear';
    return 'valor';
  });

  /** Primera vez en esta bóveda: fija la contraseña maestra. */
  protected async crearClave(): Promise<void> {
    const c = this.contrasena();
    if (c.length < MINIMO_CLAVE) {
      this.error.set(
        `Usa al menos ${MINIMO_CLAVE} caracteres. Una frase de varias palabras se recuerda ` +
          'mejor y aguanta mucho más que una palabra rara.',
      );
      return;
    }
    if (c !== this.repetir()) {
      this.error.set('Las dos contraseñas no coinciden.');
      return;
    }
    await this.con(() => this.secretos.configurar(c));
  }

  protected async desbloquear(): Promise<void> {
    await this.con(() => this.secretos.desbloquear(this.contrasena()));
  }

  /** Cifra y devuelve el bloque. El texto en claro muere aquí. */
  protected async aceptar(): Promise<void> {
    const v = this.valor();
    if (!v) return;
    await this.con(async () => {
      const datos = await this.secretos.cifrar(v);
      this.ref.close({ etiqueta: this.etiqueta().trim() || 'Secreto', datos });
    });
  }

  protected cancelar(): void {
    this.ref.close();
  }

  private async con(op: () => Promise<void>): Promise<void> {
    this.ocupado.set(true);
    this.error.set(null);
    try {
      await op();
      this.contrasena.set('');
      this.repetir.set('');
    } catch (e) {
      this.error.set(String(e).replace(/^Error:\s*/, ''));
    } finally {
      this.ocupado.set(false);
    }
  }
}
