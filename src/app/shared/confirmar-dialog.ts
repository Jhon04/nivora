import { Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';

/** Textos del diálogo de confirmación (solo `mensaje` es obligatorio). */
export interface ConfirmarDatos {
  titulo?: string;
  mensaje: string;
  aceptar?: string;
  cancelar?: string;
  /** Pinta el botón de aceptar en rojo (acciones destructivas). */
  peligro?: boolean;
}

/** Diálogo genérico de sí/no. Se cierra con `true` si el usuario confirma. */
@Component({
  selector: 'app-confirmar-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule],
  templateUrl: './confirmar-dialog.html',
  styleUrl: './confirmar-dialog.scss',
})
export class ConfirmarDialog {
  protected readonly datos = inject<ConfirmarDatos>(MAT_DIALOG_DATA);
}
