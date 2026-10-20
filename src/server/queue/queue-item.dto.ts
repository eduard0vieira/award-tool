import { ArrayMaxSize, ArrayMinSize, IsArray, IsISO8601, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from "class-validator";

export class QueueItemDto {
  @IsString({ message: "O campo source deve ser texto." })
  source!: string;

  @IsArray({ message: "O campo args deve ser uma lista." })
  @ArrayMaxSize(10, { message: "O campo args aceita no máximo 10 itens." })
  args!: unknown[];

  // One request body per leg, as the card would send them: outbound, then return.
  @IsArray({ message: "O campo legs deve ser uma lista." })
  @ArrayMinSize(1, { message: "O campo legs precisa de pelo menos uma perna." })
  @ArrayMaxSize(2, { message: "O campo legs aceita no máximo duas pernas." })
  @IsObject({ each: true, message: "Cada perna em legs deve ser um objeto." })
  legs!: Record<string, unknown>[];

  @IsString({ message: "O campo label deve ser texto." })
  @IsNotEmpty({ message: "O campo label é obrigatório." })
  @MaxLength(200, { message: "O campo label aceita no máximo 200 caracteres." })
  label!: string;

  // Absent means as soon as possible.
  @IsOptional()
  @IsISO8601({ strict: true }, { message: "O campo runAfter deve ser uma data ISO, como 2026-10-21T05:00:00.000Z." })
  runAfter?: string;
}
