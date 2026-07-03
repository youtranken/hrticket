import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FilesController } from './files.controller';
import { UploadPolicyController } from './upload-policy.controller';
import { FilesService } from './files.service';

/** Signed-URL file serving (3.7) — inline images + (Epic 8) downloads/preview. */
@Module({
  imports: [AuthModule], // SessionGuard
  controllers: [FilesController, UploadPolicyController],
  providers: [FilesService],
})
export class FilesModule {}
