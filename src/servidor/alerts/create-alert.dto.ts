import { IsNotEmpty, IsNumber, IsOptional, IsString } from "class-validator";

export class CreateAlertDto {
  @IsOptional()
  @IsString({ message: "O campo fonte deve ser texto." })
  fonte?: string;

  @IsString({ message: "O campo origem deve ser texto." })
  @IsNotEmpty({ message: "O campo origem é obrigatório." })
  origem!: string;

  @IsString({ message: "O campo destino deve ser texto." })
  @IsNotEmpty({ message: "O campo destino é obrigatório." })
  destino!: string;

  @IsString({ message: "O campo classe deve ser texto." })
  @IsNotEmpty({ message: "O campo classe é obrigatório." })
  classe!: string;

  @IsOptional()
  @IsNumber({}, { message: "O campo menorK deve ser um número." })
  menorK?: number | null;

  @IsOptional()
  @IsNumber({}, { message: "O campo maiorK deve ser um número." })
  maiorK?: number | null;

  @IsOptional()
  @IsString({ message: "O campo textoIda deve ser texto." })
  textoIda?: string;

  @IsOptional()
  @IsString({ message: "O campo textoVolta deve ser texto." })
  textoVolta?: string;
}
