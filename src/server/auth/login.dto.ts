import { IsString } from "class-validator";

export class LoginDto {
  @IsString({ message: "Informe o usuário." })
  user!: string;

  @IsString({ message: "Informe a senha." })
  pass!: string;
}
