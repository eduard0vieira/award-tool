import { IsBoolean, IsOptional, IsString } from "class-validator";

export class AnswerQuestionDto {
  @IsOptional()
  @IsString({ message: "O campo id deve ser texto." })
  id?: string;

  @IsBoolean({ message: "O campo proceed deve ser verdadeiro ou falso." })
  proceed!: boolean;
}
